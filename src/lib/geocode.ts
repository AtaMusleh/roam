/**
 * Naming a place: a coordinate in, a name out.
 *
 * Two OpenStreetMap services, asked in order, because they answer different
 * questions:
 *
 *  1. **Overpass** (`./overpass`) — "what is mapped around here?" This is the
 *     question worth asking, and it produces "Colosseo".
 *  2. **Nominatim** — "what address is here?" A good question about a doorway
 *     and the wrong one about a piazza: it produces "Piazza del Colosseo".
 *     Kept as the fallback, because a café on a residential street has no
 *     landmark and its street name is exactly the right answer.
 *  3. **The coordinate itself**, formatted, when both come up empty.
 *
 * Both services are free, volunteer-run, and need no API key. In exchange
 * their etiquette is worth honouring to the letter:
 *
 *  - **Spaced requests.** Nominatim's policy is a hard one per second;
 *    Overpass has no published limit, which makes restraint more important
 *    rather than less. Each service has its own queue in `./rate-limit`.
 *  - **A User-Agent that identifies the application**, with a way to make
 *    contact. A generic or absent one gets blocked.
 *  - **Cache the results.** Hence `GeocodeCache`: a coordinate is looked up
 *    once, ever, and every later clustering of the same trip reads the row.
 *
 * Naming is a nicety, not a dependency. If both services are slow, unreachable
 * or unhelpful, this returns a formatted coordinate string and the pipeline
 * carries on. A place called "41.8986°N, 12.4769°E" is worse than "Pantheon"
 * and far better than a failed import.
 */

import { z } from "zod";

import { haversineDistance } from "./geo";
import type { LatLng } from "./geo";
import { findLandmark } from "./overpass";
import { prisma } from "./prisma";
import { createRateLimiter, userAgent } from "./rate-limit";

/**
 * Decimal places the cache key is rounded to. Four is about 11m at the
 * equator — smaller than any place, so two clusterings of the same trip land
 * on the same key, while genuinely different places do not collide.
 */
const CACHE_PRECISION = 4;

/**
 * Minimum spacing between requests. The policy is one per second; the extra
 * 200ms absorbs clock jitter and keeps us on the right side of it even if two
 * requests are timed back to back.
 */
const MIN_REQUEST_SPACING_MS = 1_200;

/** How long to wait for Nominatim before falling back to coordinates. */
const REQUEST_TIMEOUT_MS = 8_000;

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

export interface GeocodedPlace {
  name: string;
  address: string | null;
  /** Where the answer came from. Useful in logs and tests. */
  source: "cache" | "overpass" | "nominatim" | "fallback";
}

export interface GeocodeOptions {
  /**
   * Ignore any cached name and ask the services again, overwriting the cached
   * row with what comes back. For testing naming changes without hand-deleting
   * rows; never for ordinary use, since the whole point of the cache is that a
   * coordinate is looked up once.
   */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// The rate limiter
// ---------------------------------------------------------------------------

/**
 * Nominatim gets its own limiter, separate from the Overpass one, because the
 * etiquette is per-service: a landmark lookup and a reverse lookup are aimed
 * at different volunteers' servers and need not wait for each other.
 */
const limiter = createRateLimiter(MIN_REQUEST_SPACING_MS);

const schedule = limiter.schedule.bind(limiter);

// ---------------------------------------------------------------------------
// Talking to Nominatim
// ---------------------------------------------------------------------------

/**
 * Only the fields worth reading. Nominatim returns a great deal more, and
 * parsing loosely here means an unexpected payload degrades to the coordinate
 * fallback instead of throwing inside the import.
 */
const nominatimReverse = z.object({
  name: z.string().nullish(),
  display_name: z.string().nullish(),
  category: z.string().nullish(),
  type: z.string().nullish(),
  /** Position of the matched object. Nominatim returns these as strings. */
  lat: z.string().nullish(),
  lon: z.string().nullish(),
  address: z.record(z.string(), z.string()).nullish(),
  error: z.string().nullish(),
});

type ReverseResult = z.infer<typeof nominatimReverse>;

/** Building and street level: what is directly under this coordinate. */
const DETAIL_ZOOM = 18;

/** Square and quarter level: what this coordinate is part of. */
const COARSE_ZOOM = 15;

/**
 * Picking a name is the awkward part, because reverse geocoding answers "what
 * is at this point", not "what would a person call this place". Measured
 * against the Rome demo trip, a naive read of the response produces:
 *
 *   Colosseum      -> "Municipio Roma I"        (the administrative district)
 *   Trevi Fountain -> "Oceano"                  (one statue within the fountain)
 *   Foro Romano    -> "Rostra ad Divi Iulii"    (one ruin within the forum)
 *   St Peter's     -> "Arco delle Campane"      (a gift shop by the gate)
 *
 * The trouble is that a cluster centroid lands on open ground — a piazza, a
 * courtyard — and the nearest mapped object is whatever happens to be there: a
 * defibrillator, a car park, a statue. So the choice is made in tiers, and the
 * tiers below are what the measured cases actually call for.
 */

/**
 * `category:type` pairs whose name is worth using directly.
 *
 * The distinction is scale, not importance: a museum or an archaeological site
 * *is* the place, while a monument, a memorial or an artwork is one object
 * standing inside a larger place that the photos are really about. So
 * `historic:archaeological_site` is in ("Domus Augustana" on the Palatine) and
 * `historic:temple` is out ("Rostra ad Divi Iulii" in the Forum, where "Via
 * Sacra" reads better).
 *
 * This is a heuristic tuned against one city and should be revisited as more
 * trips go through it.
 */
const LANDMARK_TYPES: ReadonlySet<string> = new Set([
  "tourism:museum",
  "tourism:attraction",
  "tourism:gallery",
  "tourism:viewpoint",
  "tourism:zoo",
  "tourism:aquarium",
  "tourism:theme_park",
  "historic:castle",
  "historic:fort",
  "historic:ruins",
  "historic:archaeological_site",
  "historic:palace",
  "historic:monastery",
  "historic:city_gate",
  "amenity:place_of_worship",
  "amenity:theatre",
  "amenity:arts_centre",
  "amenity:marketplace",
  "amenity:cafe",
  "amenity:restaurant",
  "amenity:bar",
  "amenity:pub",
  "amenity:library",
  "leisure:park",
  "leisure:garden",
  "leisure:nature_reserve",
  "leisure:stadium",
  "building:cathedral",
  "building:church",
  "building:palace",
  "building:castle",
  "man_made:lighthouse",
  "man_made:bridge",
  "man_made:tower",
  "natural:beach",
  "natural:peak",
  "place:square",
]);

/**
 * Address keys naming the ground you are standing on. In an old European city
 * this is usually the best label there is: "Piazza del Colosseo", "Campo de'
 * Fiori", "Piazza di Trevi" are exactly what someone would write under a photo.
 */
const GROUND_KEYS: readonly string[] = ["square", "pedestrian", "road"];

/** Keys that only say which district you are in. A last resort. */
const AREA_KEYS: readonly string[] = [
  "neighbourhood",
  "quarter",
  "suburb",
  "city_district",
  "town",
  "village",
  "city",
];

function firstKey(
  address: Record<string, string> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!address) return null;

  for (const key of keys) {
    const value = address[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * How far the matched object may be from the query point and still name it.
 *
 * The detail lookup is at building zoom, so a match hundreds of metres away is
 * a bad match rather than a distant landmark. This was observed: the Colosseum
 * centroid intermittently came back named "Colle Palatino" — the Palatine
 * Hill, 450m away and a different site entirely. 150m matches the radius the
 * Overpass tier searches.
 */
const MAX_DETAIL_MATCH_METERS = 150;

/**
 * The same check at the coarse tier, where a match is legitimately an area and
 * so legitimately further off.
 *
 * Generous enough for the centre of a square to count — Piazza Navona and Campo
 * de' Fiori both reach this tier and are named correctly by it — and tight
 * enough to reject the case that prompted it: when Nominatim's building-level
 * answer for the Colosseum comes back as the unnamed pedestrian area (which it
 * does intermittently, the alternative being a node that carries the street
 * name), this tier was offering "Colle Palatino", a named spot on the Palatine
 * Hill 433m away and across the archaeological park.
 */
const MAX_COARSE_MATCH_METERS = 250;

/** Reads the matched object's own position, which Nominatim returns as strings. */
function matchedPosition(parsed: ReverseResult): LatLng | null {
  const lat = Number(parsed.lat);
  const lng = Number(parsed.lon);

  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * The response's own name, but only when it is at the scale of a place *and*
 * actually here.
 *
 * The `address` fields below need no such check — they describe the query
 * point itself. Only this tier takes the name of a matched object, so only
 * this tier can be handed the name of somewhere else.
 */
function landmarkName(parsed: ReverseResult, point: LatLng): string | null {
  const name = parsed.name?.trim();
  if (!name) return null;

  if (!LANDMARK_TYPES.has(`${parsed.category ?? ""}:${parsed.type ?? ""}`)) {
    return null;
  }

  const position = matchedPosition(parsed);
  if (position && haversineDistance(point, position) > MAX_DETAIL_MATCH_METERS) {
    return null;
  }

  return name;
}

/** `41.8986°N, 12.4769°E` — the answer when there is no better one. */
export function formatCoordinates(point: LatLng): string {
  const lat = `${Math.abs(point.lat).toFixed(4)}°${point.lat >= 0 ? "N" : "S"}`;
  const lng = `${Math.abs(point.lng).toFixed(4)}°${point.lng >= 0 ? "E" : "W"}`;
  return `${lat}, ${lng}`;
}

export function roundForCache(value: number): number {
  return Number(value.toFixed(CACHE_PRECISION));
}

async function fetchReverse(
  point: LatLng,
  zoom: number,
): Promise<ReverseResult | null> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(point.lat));
  url.searchParams.set("lon", String(point.lng));
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Nominatim replied ${response.status} ${response.statusText}`);
  }

  const parsed = nominatimReverse.safeParse(await response.json());

  // A body we cannot read is a fault, not an answer. Throwing keeps it
  // distinguishable from Nominatim successfully reporting that it has nothing
  // at this coordinate, which is the `null` below — and that distinction is
  // what decides whether the result is safe to cache forever.
  if (!parsed.success) {
    throw new Error("Nominatim returned an unreadable body");
  }

  return parsed.data.error ? null : parsed.data;
}

interface LookupOutcome {
  name: string;
  address: string | null;
  /** Which service produced the name. */
  source: "overpass" | "nominatim";
  /**
   * Whether this name is the best one available, and so safe to cache.
   *
   * False when a tier failed transiently: the answer is usable now, but a
   * better one probably exists, and the cache is forever. A degraded name
   * written to `GeocodeCache` would outlive the outage that caused it — which
   * is exactly how the Colosseum ends up permanently called "Celio".
   */
  cacheable: boolean;
}

/**
 * Names a coordinate, in tiers, coarsening only as far as it has to.
 *
 * The second request is only made when the detailed one found nothing but an
 * administrative district — a centroid sitting in the middle of an unnamed
 * pedestrian area, which is what Piazza Navona and Campo de' Fiori both look
 * like from directly overhead. Asking again at square level is what turns
 * "Parione" into "Piazza Navona". On the Rome trip that costs two extra
 * requests out of eleven places, once, and never again after caching.
 */
async function lookupName(point: LatLng): Promise<LookupOutcome | null> {
  // Tier 0: what is actually *here*, per OpenStreetMap.
  //
  // This runs first because it answers the right question. The reverse tiers
  // below answer "what address is this", which is what turns the Colosseum
  // into "Piazza del Colosseo" — correct, and not the name of the place.
  let landmarkFailed = false;

  try {
    const landmark = await findLandmark(point);
    if (landmark) {
      return {
        name: landmark.name,
        address: landmark.address,
        source: "overpass",
        cacheable: true,
      };
    }
    // `null` is Overpass answering that nothing around here qualifies — a
    // café, a residential street. The reverse tiers are the right answer then,
    // and their result is worth caching.
  } catch {
    // The request failed, which is a different thing entirely: a landmark may
    // well be here and we simply could not ask. Carry on to the reverse tiers
    // so the import still gets a name, but refuse to cache it, or an Overpass
    // outage would permanently name this place after its street.
    landmarkFailed = true;
  }

  // Deliberately not caught: a failure here means the best remaining tier
  // never ran, and the caller should fall back to coordinates and try again
  // next time rather than settle for a district name it would then cache.
  const detail = await schedule(() => fetchReverse(point, DETAIL_ZOOM));

  // `detail === null` is Nominatim saying it has nothing at this coordinate.
  // In a densely mapped city that is far more likely to be a hiccup than the
  // truth, and it was observed once: a stray null here demoted the Colosseum
  // from "Piazza del Colosseo" to "Celio", the surrounding rione. So while the
  // coarser tiers below still run, nothing they produce may be cached — a
  // one-off blip must not become the permanent name of a place.
  const detailAnswered = detail !== null;

  const address = detail?.display_name?.trim() ?? null;

  const specific =
    detail === null
      ? null
      : (landmarkName(detail, point) ?? firstKey(detail.address, GROUND_KEYS));

  if (specific !== null) {
    return {
      name: specific,
      address,
      source: "nominatim",
      cacheable: !landmarkFailed,
    };
  }

  let coarse: ReverseResult | null = null;
  let coarseFailed = false;

  try {
    coarse = await schedule(() => fetchReverse(point, COARSE_ZOOM));
  } catch {
    // The detail tier did run and found only a district. That is worth
    // returning, but not worth remembering, since the square-level name this
    // request would have found is the better one.
    coarseFailed = true;
  }

  const coarsePosition = coarse === null ? null : matchedPosition(coarse);
  const coarseIsHere =
    coarsePosition === null ||
    haversineDistance(point, coarsePosition) <= MAX_COARSE_MATCH_METERS;

  const square =
    coarse === null || !coarseIsHere
      ? null
      : (coarse.name?.trim() || firstKey(coarse.address, GROUND_KEYS));

  if (square) {
    return {
      name: square,
      address: address ?? coarse?.display_name?.trim() ?? null,
      source: "nominatim",
      cacheable: detailAnswered && !landmarkFailed,
    };
  }

  // Nothing but the district. Better than a coordinate, if only just.
  const area =
    firstKey(detail?.address, AREA_KEYS) ?? firstKey(coarse?.address, AREA_KEYS);

  if (area === null) return null;

  return {
    name: area,
    address,
    source: "nominatim",
    cacheable: detailAnswered && !coarseFailed && !landmarkFailed,
  };
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * In-flight lookups, so two clusters rounding to the same cache cell within one
 * import share a single request rather than queueing two.
 */
const inFlight = new Map<string, Promise<GeocodedPlace>>();

function cacheKey(lat: number, lng: number): string {
  return `${lat},${lng}`;
}

/**
 * Names a coordinate.
 *
 * Never rejects. Every failure path — no network, a timeout, a rate-limit
 * response, an unparseable body, a coordinate in the middle of the sea —
 * resolves to a formatted coordinate string, because naming a place must never
 * be able to fail an import.
 *
 * Successful lookups are written to `GeocodeCache`. Failures deliberately are
 * not: caching a fallback would make a transient outage permanent, and the
 * next run should try again.
 */
export async function reverseGeocode(
  point: LatLng,
  options: GeocodeOptions = {},
): Promise<GeocodedPlace> {
  const roundedLat = roundForCache(point.lat);
  const roundedLng = roundForCache(point.lng);
  const key = cacheKey(roundedLat, roundedLng);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const lookup = (async (): Promise<GeocodedPlace> => {
    if (!options.force) {
      try {
        const cached = await prisma.geocodeCache.findUnique({
          where: { roundedLat_roundedLng: { roundedLat, roundedLng } },
        });

        if (cached) {
          return { name: cached.name, address: cached.address, source: "cache" };
        }
      } catch {
        // A cache read failure is not worth failing over; fall through and ask
        // the services directly.
      }
    }

    let result: LookupOutcome | null = null;

    try {
      // Query the rounded coordinate, not the raw one, so the request and the
      // cache key always describe the same 11m cell. Otherwise a centroid that
      // shifts by a metre between clusterings could return a different name
      // than the one already cached against it.
      result = await lookupName({ lat: roundedLat, lng: roundedLng });
    } catch {
      result = null;
    }

    if (result === null) {
      return {
        name: formatCoordinates(point),
        address: null,
        source: "fallback",
      };
    }

    if (!result.cacheable) {
      // Usable now, but a tier failed on the way here, so a better name may be
      // waiting. Hand it back without writing it down; the next run retries.
      return { name: result.name, address: result.address, source: result.source };
    }

    try {
      // `upsert` rather than `create`: another process may have cached the same
      // cell in the meantime, and losing that race should not fail the lookup.
      await prisma.geocodeCache.upsert({
        where: { roundedLat_roundedLng: { roundedLat, roundedLng } },
        create: {
          roundedLat,
          roundedLng,
          name: result.name,
          address: result.address,
        },
        update: { name: result.name, address: result.address, fetchedAt: new Date() },
      });
    } catch {
      // The name is already in hand; failing to cache it is not worth failing
      // the lookup over. The next run pays for one more request.
    }

    return { name: result.name, address: result.address, source: result.source };
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, lookup);
  return lookup;
}

/**
 * Names several coordinates.
 *
 * Written as a plain `Promise.all` on purpose: the queue inside
 * `reverseGeocode` already serialises the network calls, so this fans out over
 * the cache (instant) while the uncached ones proceed one per second.
 */
export function reverseGeocodeAll(
  points: readonly LatLng[],
  options: GeocodeOptions = {},
): Promise<GeocodedPlace[]> {
  return Promise.all(points.map((point) => reverseGeocode(point, options)));
}
