/**
 * Landmark lookup via the Overpass API.
 *
 * Reverse geocoding answers "what address is here", which is the wrong
 * question. A cluster centroid sits in the middle of a piazza, so the nearest
 * addressable thing is the piazza — the Colosseum comes back as "Piazza del
 * Colosseo", the Pantheon as "Via della Rotonda", St Peter's as "Arco delle
 * Campane". Accurate, and not what anyone would write under the photo.
 *
 * Overpass answers a different question: what is actually mapped around this
 * point. Asking it for prominent features within 150m and picking the most
 * significant one gets "Colosseo" instead of the street it stands on.
 *
 * Overpass is free, volunteer-run, and has no published rate limit — which
 * means the etiquette matters more, not less. Requests are spaced, retried
 * gently on the server's own backpressure signals, and cached so a coordinate
 * is asked about once.
 */

import { haversineDistance } from "./geo";
import type { LatLng } from "./geo";
import { createRateLimiter, sleep, userAgent } from "./rate-limit";

const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

/**
 * The Overpass instance to query.
 *
 * Overridable because the public instance goes down — during development every
 * public instance was unreachable or returning 502 for an extended stretch —
 * and because a project making heavy use of Overpass should be running its own
 * instance rather than leaning on the free one. Set `OVERPASS_ENDPOINT` to a
 * mirror or a private instance.
 */
function endpoint(): string {
  return process.env.OVERPASS_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

/**
 * How far around the centroid to look.
 *
 * 150m is about the radius of a large piazza. Wider starts pulling in the
 * landmark on the *next* square, which is worse than no landmark at all.
 */
const DEFAULT_RADIUS_METERS = 150;

/**
 * Spacing between Overpass requests.
 *
 * The etiquette expectation is at least a second. Measured against the public
 * instance, one second is not enough — most requests came back 429 — so this
 * is two, with the retry below for when even that is too eager.
 */
const REQUEST_SPACING_MS = 2_000;

const REQUEST_TIMEOUT_MS = 15_000;

/** Backoff before each retry after the server pushes back. */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];

/**
 * Consecutive failures before the circuit opens and lookups are skipped.
 *
 * This exists because of what an outage costs without it. Every public
 * Overpass instance was unreachable during development, and each lookup then
 * burned a 15s connect timeout plus two backed-off retries — around 40 seconds
 * per place, turning a twelve-place import into an eight-minute one, to
 * produce nothing. Landmark naming is an enrichment; it is not allowed to
 * dominate the runtime when it is not working.
 */
const FAILURE_THRESHOLD = 3;

/** How long to leave the circuit open before trying again. */
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

const limiter = createRateLimiter(REQUEST_SPACING_MS);

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** Thrown when the circuit is open, so callers see a failure, not an absence. */
class OverpassUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassUnavailableError";
  }
}

export interface Landmark {
  name: string;
  /** The tag that qualified it, e.g. `tourism=attraction`. */
  kind: string;
  distanceMeters: number;
  hasWikidata: boolean;
  /** Composed from the feature's own `addr:*` tags, when it has any. */
  address: string | null;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How much each tag suggests "this is the place the photos are of".
 *
 * The ordering is drawn from what the Rome centroids actually return:
 *
 *  - `tourism=attraction` tops it because that is how the headline sights are
 *    tagged — Fontana di Trevi, Colle Palatino, the Basilica di Santa Maria in
 *    Trastevere all carry it.
 *  - `tourism=museum` sits just below, which is what keeps the Museo di Roma
 *    from outranking the basilica across the square from it.
 *  - `tourism=artwork` is deliberately near the bottom. It is how single
 *    statues are tagged, and a statue standing in a fountain is not the
 *    fountain: this is the tag that produced "Oceano" for the Trevi Fountain.
 *  - A plain `building` only qualifies at all when it carries a Wikidata or
 *    Wikipedia reference, so it ranks last as a tie-breaker of last resort.
 */
const TAG_SIGNIFICANCE: ReadonlyMap<string, number> = new Map([
  ["tourism=attraction", 100],
  ["tourism=museum", 90],
  ["tourism=gallery", 88],
  ["amenity=place_of_worship", 80],
  ["historic=castle", 76],
  ["historic=palace", 75],
  ["historic=archaeological_site", 74],
  ["historic=ruins", 72],
  ["historic=fort", 72],
  ["historic=city_gate", 66],
  ["historic=church", 66],
  ["historic=monument", 64],
  ["leisure=park", 60],
  ["tourism=viewpoint", 55],
  ["historic=memorial", 45],
  ["tourism=artwork", 40],
]);

/** Any other `historic=*` value still counts, just modestly. */
const HISTORIC_FALLBACK_SIGNIFICANCE = 62;

const BUILDING_SIGNIFICANCE = 30;

/**
 * Width of the distance bands used for ranking, in metres.
 *
 * Distance is the first criterion, but comparing raw metres would settle every
 * contest on its own — two features are never exactly equidistant, so
 * notability and tag significance would never get a say. Banding restores
 * them: anything within the same 100m of the centroid is "equally near", and
 * the later criteria decide.
 *
 * The width is load-bearing. At 50m the Vatican Museums lose to "Porta Musei
 * Vaticani", a gate 25m from the centroid; at 100m the museum polygon and the
 * gate land in one band and notability picks the museum.
 */
const DISTANCE_BAND_METERS = 100;

interface Candidate {
  name: string;
  kind: string;
  significance: number;
  /** 2 for Wikidata *and* Wikipedia, 1 for either, 0 for neither. */
  notability: number;
  hasWikidata: boolean;
  distanceMeters: number;
  address: string | null;
}

/**
 * Scores one element's tags, returning the strongest qualifying tag.
 *
 * Features often carry several: the basilica in Trastevere is simultaneously
 * `tourism=attraction`, `amenity=place_of_worship` and `building=basilica`.
 * The strongest wins, so a landmark is judged by its best claim.
 */
function classify(
  tags: Record<string, string>,
  notable: boolean,
): { kind: string; significance: number } | null {
  let best: { kind: string; significance: number } | null = null;

  const consider = (kind: string, significance: number): void => {
    if (best === null || significance > best.significance) {
      best = { kind, significance };
    }
  };

  for (const key of ["tourism", "amenity", "leisure", "historic"] as const) {
    const value = tags[key];
    if (value === undefined) continue;

    const pair = `${key}=${value}`;
    const known = TAG_SIGNIFICANCE.get(pair);

    if (known !== undefined) {
      consider(pair, known);
    } else if (key === "historic") {
      // `historic=*` is open-ended and every value of it marks something old
      // and deliberate, which is exactly what a traveller photographs.
      consider(pair, HISTORIC_FALLBACK_SIGNIFICANCE);
    }
  }

  // A building only qualifies if someone thought it worth linking to Wikidata
  // or Wikipedia. Otherwise every apartment block on the square is a candidate.
  const building = tags["building"];
  if (best === null && building !== undefined && notable) {
    consider(`building=${building}`, BUILDING_SIGNIFICANCE);
  }

  return best;
}

/** Builds a street address out of a feature's own `addr:*` tags, if it has any. */
function composeAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"]?.trim();
  const houseNumber = tags["addr:housenumber"]?.trim();
  const city = tags["addr:city"]?.trim();
  const postcode = tags["addr:postcode"]?.trim();

  const line = [street, houseNumber].filter(Boolean).join(" ").trim();
  const parts = [line, postcode, city].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Orders candidates best-first: nearest band, then most notable, then most
 * significant tag, then genuinely nearest.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const bandA = Math.floor(a.distanceMeters / DISTANCE_BAND_METERS);
  const bandB = Math.floor(b.distanceMeters / DISTANCE_BAND_METERS);
  if (bandA !== bandB) return bandA - bandB;

  if (a.notability !== b.notability) return b.notability - a.notability;
  if (a.significance !== b.significance) return b.significance - a.significance;

  return a.distanceMeters - b.distanceMeters;
}

// ---------------------------------------------------------------------------
// Talking to Overpass
// ---------------------------------------------------------------------------

/**
 * The candidate filter, as Overpass QL.
 *
 * `nwr` covers nodes, ways and relations, because a landmark may be mapped as
 * any of the three, and `out center` gives ways and relations a single
 * representative point to measure from. Every clause requires `name`: an
 * unnamed feature cannot name a place.
 */
function buildQuery(point: LatLng, radiusMeters: number): string {
  const around = `around:${radiusMeters},${point.lat},${point.lng}`;

  return `[out:json][timeout:25];
(
  nwr(${around})["name"]["tourism"~"^(attraction|museum|artwork|gallery|viewpoint)$"];
  nwr(${around})["name"]["historic"];
  nwr(${around})["name"]["amenity"="place_of_worship"];
  nwr(${around})["name"]["leisure"="park"];
  nwr(${around})["name"]["building"]["wikidata"];
  nwr(${around})["name"]["building"]["wikipedia"];
);
out center tags;`;
}

interface OverpassElement {
  type?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: unknown;
  tags?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads an element's position: its own for a node, `center` for a way. */
function positionOf(element: OverpassElement): LatLng | null {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lng: element.lon };
  }

  if (isRecord(element.center)) {
    const { lat, lon } = element.center;
    if (typeof lat === "number" && typeof lon === "number") {
      return { lat, lng: lon };
    }
  }

  return null;
}

function stringTags(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;

  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (typeof tagValue === "string") tags[key] = tagValue;
  }
  return tags;
}

/**
 * One request, with a short retry for the server's own backpressure.
 *
 * 429 ("slot unavailable") and 504 ("gateway timeout") both mean the public
 * instance is busy rather than that the query is wrong, and both are common
 * enough that a single attempt fails most of the time. Anything else is a real
 * error and is not retried.
 */
async function attemptRequest(query: string): Promise<unknown> {
  let lastError: Error = new Error("Overpass request never ran");

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] as number);

    const response = await limiter.schedule(() =>
      fetch(endpoint(), {
        method: "POST",
        headers: {
          "User-Agent": userAgent(),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );

    if (response.ok) return response.json();

    lastError = new Error(
      `Overpass replied ${response.status} ${response.statusText}`,
    );

    if (response.status !== 429 && response.status !== 504) throw lastError;
  }

  throw lastError;
}

/**
 * One request, wrapped in a circuit breaker.
 *
 * While the circuit is open every lookup fails instantly rather than waiting
 * on a server that is not answering. Callers cannot tell the difference — both
 * are thrown errors, both mean "we could not find out", and neither is
 * cacheable — but an import stays fast instead of grinding through timeouts.
 */
async function requestOverpass(query: string): Promise<unknown> {
  if (Date.now() < circuitOpenUntil) {
    throw new OverpassUnavailableError(
      "Overpass lookups are paused after repeated failures",
    );
  }

  try {
    const body = await attemptRequest(query);
    consecutiveFailures = 0;
    return body;
  } catch (error) {
    consecutiveFailures += 1;

    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }

    throw error;
  }
}

/**
 * Closes the circuit and forgets recent failures.
 *
 * For tests and for a deliberate retry after an outage; ordinary code should
 * let the cooldown expire on its own.
 */
export function resetOverpassCircuit(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

export interface FindLandmarkOptions {
  radiusMeters?: number;
}

/**
 * Finds the most likely landmark around a point.
 *
 * Returns `null` when Overpass answered and nothing within the radius
 * qualifies — a café, a residential street, a car park. **Throws** when the
 * request itself failed, so the caller can tell "there is no landmark here"
 * from "we could not find out", and refuse to cache the second.
 */
export async function findLandmark(
  point: LatLng,
  options: FindLandmarkOptions = {},
): Promise<Landmark | null> {
  const radiusMeters = options.radiusMeters ?? DEFAULT_RADIUS_METERS;
  const body = await requestOverpass(buildQuery(point, radiusMeters));

  if (!isRecord(body) || !Array.isArray(body.elements)) {
    throw new Error("Overpass returned an unreadable body");
  }

  return selectLandmark(point, body.elements);
}

/**
 * Picks the best landmark from a set of Overpass elements.
 *
 * Split out from the request so the judgement — which is all the interesting
 * part — can be tested against recorded payloads without touching a volunteer
 * server. Returns `null` when nothing qualifies.
 */
export function selectLandmark(
  point: LatLng,
  elements: readonly unknown[],
): Landmark | null {
  const candidates: Candidate[] = [];

  for (const raw of elements) {
    if (!isRecord(raw)) continue;

    const element = raw as OverpassElement;
    const tags = stringTags(element.tags);
    const position = positionOf(element);
    if (!tags || !position) continue;

    const name = tags["name"]?.trim();
    if (!name) continue;

    const hasWikidata = Boolean(tags["wikidata"]?.trim());
    const hasWikipedia = Boolean(tags["wikipedia"]?.trim());

    const classified = classify(tags, hasWikidata || hasWikipedia);
    if (!classified) continue;

    candidates.push({
      name,
      kind: classified.kind,
      significance: classified.significance,
      notability: (hasWikidata ? 1 : 0) + (hasWikipedia ? 1 : 0),
      hasWikidata,
      distanceMeters: haversineDistance(point, position),
      address: composeAddress(tags),
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort(compareCandidates);
  const best = candidates[0] as Candidate;

  return {
    name: best.name,
    kind: best.kind,
    distanceMeters: best.distanceMeters,
    hasWikidata: best.hasWikidata,
    address: best.address,
  };
}
