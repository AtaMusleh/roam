/**
 * Synthetic trip generator.
 *
 *   npx tsx scripts/generate-trip.ts --city rome
 *   npx tsx scripts/generate-trip.ts --city athens --seed 7
 *
 * Produces a photo dataset shaped like a real camera roll after a week in a
 * city, together with the ground truth — which photo was really taken at which
 * place — so clustering accuracy can be scored against it later.
 *
 * The itinerary comes from `data/itineraries/<city>.json`: real coordinates,
 * intended visit durations, per-place GPS spread and photo counts. The dataset
 * lands in `data/<city>-trip.json`.
 *
 * What makes these datasets hard, on purpose — and each itinerary leans on
 * these differently, so the cities are not four copies of one trip:
 *
 *  - Gaussian GPS noise around each place, with a per-place sigma. A café gets
 *    8m; a hillside archaeological site gets 95m.
 *  - Places close enough to merge: the Pantheon and a café 100m away in Rome,
 *    the Boqueria 65m off La Rambla in Barcelona, the Parthenon 88m inside the
 *    Acropolis in Athens.
 *  - Sparse photos strung along the route between consecutive stops, which
 *    belong to no cluster at all.
 *  - Photos carrying no coordinates, so their place has to be recovered from
 *    timestamps alone.
 *  - Revisits — one place, two visits — which clustering on position alone
 *    will collapse.
 *  - Genuine outliers, day trips well outside the city, which must not be
 *    absorbed into the nearest cluster.
 *
 * Everything is driven by a seeded PRNG, so the same seed always produces the
 * same dataset and accuracy numbers stay comparable between runs.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { haversineDistance, interpolate, offsetByMeters } from "../src/lib/geo";
import type { LatLng } from "../src/lib/geo";
import type {
  GeneratedPhoto,
  GeneratedPlace,
  GeneratedTripDataset,
  GeneratedVisit,
  PhotoAssignment,
  PhotoOrigin,
  PlaceSpec,
  TripSpec,
  VisitSpec,
} from "../src/types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Fallback GPS noise for a place that does not specify its own sigma. */
const DEFAULT_SIGMA_METERS = 20;

/** Fraction of photos that lose their coordinates, as a real camera roll does. */
const DEFAULT_GPS_STRIP_RATE = 0.15;

const DEFAULT_SEED = 42;

/** Where itineraries live, one JSON file per city. */
const ITINERARY_DIR = "data/itineraries";

/** The city generated when none is named. */
const DEFAULT_CITY = "rome";

/** Datasets are written per city, alongside the itineraries they came from. */
function datasetPathFor(city: string): string {
  return `data/${city}-trip.json`;
}

const DEFAULT_CLOUD_NAME = "roam-demo";

/** GPS is noisier in motion than standing still. */
const TRANSIT_SIGMA_METERS = 25;

/** Transit photos are only generated for gaps inside this range. */
const TRANSIT_MIN_GAP_MINUTES = 5;
const TRANSIT_MAX_GAP_MINUTES = 240;

/** Chance that a given gap between stops produced no photos at all. */
const TRANSIT_EMPTY_CHANCE = 0.55;

const TRANSIT_MAX_PHOTOS = 3;

/** Fraction of photos still awaiting a blurhash from the upload pipeline. */
const BLURHASH_MISSING_RATE = 0.08;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly [T, ...T[]]): T;
  /** Standard normal, mean 0 and standard deviation 1. */
  gaussian(): number;
}

/**
 * mulberry32 — small, fast, and good enough for synthetic data. Chosen over
 * `Math.random` purely because it takes a seed, which is what makes runs
 * reproducible.
 */
function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller yields two independent normals per pair of uniforms; the spare
  // is handed out on the following call.
  let spare: number | null = null;

  const gaussian = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }

    // `next()` can return exactly 0, and log(0) is -Infinity.
    const u = 1 - next();
    const v = next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;

    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };

  const pick = <T,>(items: readonly [T, ...T[]]): T => {
    const index = Math.floor(next() * items.length);
    return items[index] ?? items[0];
  };

  return {
    next,
    gaussian,
    pick,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}

/** cuid-shaped ids, drawn from the seeded RNG so datasets stay reproducible. */
function createIdFactory(rng: Rng): () => string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

  return () => {
    let id = "c";
    for (let i = 0; i < 24; i += 1) {
      id += alphabet[Math.floor(rng.next() * alphabet.length)];
    }
    return id;
  };
}

// ---------------------------------------------------------------------------
// Photo metadata
// ---------------------------------------------------------------------------

interface PhotoShape {
  width: number;
  height: number;
}

const PHOTO_SHAPES: readonly [PhotoShape, ...PhotoShape[]] = [
  { width: 4032, height: 3024 },
  { width: 3024, height: 4032 },
  { width: 4032, height: 2268 },
  { width: 2268, height: 4032 },
  { width: 3024, height: 3024 },
];

/**
 * Real blurhash strings, reused as placeholders. The generator has no pixels to
 * hash, and a random base83 string would decode to noise rather than to
 * something that reads as a plausible photo thumbnail.
 */
const BLURHASH_POOL: readonly [string, ...string[]] = [
  "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
  "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
  "LlMF%n00%#MwS|WCWEM{R*bbWBbH",
  "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
  "L9AB*A%h00xu?bogM{WB4nWB-;j[",
];

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a local calendar date plus a wall-clock time into an absolute
 * instant.
 *
 * The trip carries a fixed UTC offset rather than an IANA zone so this script
 * stays dependency-free. Each itinerary sits well inside one season, so nothing
 * is lost; a trip spanning a DST boundary would need a real timezone library.
 */
function localInstant(
  startDate: string,
  dayOffset: number,
  timeOfDay: string,
  utcOffsetMinutes: number,
): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!dateMatch) {
    throw new Error(`Trip startDate must be YYYY-MM-DD, got "${startDate}"`);
  }

  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!timeMatch) {
    throw new Error(`Time of day must be HH:MM, got "${timeOfDay}"`);
  }

  const [, year, month, day] = dateMatch;
  const [, hours, minutes] = timeMatch;

  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day) + dayOffset,
      Number(hours),
      Number(minutes),
    ) -
    utcOffsetMinutes * MINUTE_MS
  );
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Timestamps for one stay, in bursts rather than spread evenly.
 *
 * People photograph in flurries — six shots of the same ceiling in half a
 * minute, then nothing for twenty. Uniform sampling would hand a time-gap
 * clusterer an unrealistically clean signal.
 */
function burstTimestamps(
  rng: Rng,
  count: number,
  startMs: number,
  endMs: number,
): number[] {
  if (count <= 0) return [];

  const span = Math.max(endMs - startMs, 1);
  const stamps: number[] = [];

  while (stamps.length < count) {
    const burstSize = Math.min(count - stamps.length, rng.int(1, 5));
    let cursor = startMs + rng.next() * span;

    for (let i = 0; i < burstSize; i += 1) {
      stamps.push(Math.min(endMs, Math.round(cursor)));
      cursor += rng.int(3_000, 25_000);
    }
  }

  return stamps.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The built-in itinerary
// ---------------------------------------------------------------------------

/**
 * Loads a city's itinerary.
 *
 * Itineraries live in `data/itineraries/<slug>.json` rather than in this file:
 * they are data, several cities' worth of it, and a generator that has to be
 * edited to add a trip is a generator with a hard-coded trip. The shape is
 * `TripSpec` — the same one the code below has always taken.
 */
function loadItinerary(city: string): TripSpec {
  const path = resolve(process.cwd(), ITINERARY_DIR, `${city}.json`);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    const available = availableCities();
    throw new Error(
      `No itinerary for "${city}" at ${path}.\n` +
        `Available: ${available.length > 0 ? available.join(", ") : "none"}`,
    );
  }

  const spec = JSON.parse(raw) as TripSpec;
  validateItinerary(city, spec);
  return spec;
}

/** The city slugs that have an itinerary, read from the directory itself. */
export function availableCities(): string[] {
  try {
    return readdirSync(resolve(process.cwd(), ITINERARY_DIR))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Checks the parts of an itinerary that would otherwise fail confusingly deep
 * inside generation — a visit naming a place that does not exist, say.
 */
function validateItinerary(city: string, spec: TripSpec): void {
  const problems: string[] = [];

  if (!spec.name || !spec.slug) problems.push("needs a name and a slug");
  if (typeof spec.utcOffsetMinutes !== "number") {
    problems.push("needs utcOffsetMinutes");
  }
  if (!Array.isArray(spec.places) || spec.places.length === 0) {
    problems.push("needs at least one place");
  }
  if (!Array.isArray(spec.visits) || spec.visits.length === 0) {
    problems.push("needs at least one visit");
  }

  const keys = new Set((spec.places ?? []).map((place) => place.key));
  for (const visit of spec.visits ?? []) {
    if (!keys.has(visit.placeKey)) {
      problems.push(`visit refers to unknown place "${visit.placeKey}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`${city}.json: ${problems.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface GeneratorOptions {
  seed: number;
  defaultSigmaMeters: number;
  gpsStripRate: number;
  cloudName: string;
}

/** A photo plus its answer key, before the two are split apart for output. */
interface PhotoDraft {
  photo: GeneratedPhoto;
  assignment: PhotoAssignment;
}

function resolveSigma(place: PlaceSpec, fallback: number): number {
  return place.sigmaMeters ?? fallback;
}

/** Scatters a point around `center` with independent Gaussian noise per axis. */
function scatter(rng: Rng, center: LatLng, sigmaMeters: number): LatLng {
  return offsetByMeters(
    center,
    rng.gaussian() * sigmaMeters,
    rng.gaussian() * sigmaMeters,
  );
}

function roundCoordinate(value: number): number {
  // Seven decimals is roughly 1cm — well past what any phone GPS resolves, and
  // about where EXIF rationals land anyway.
  return Number(value.toFixed(7));
}

function generate(spec: TripSpec, options: GeneratorOptions): GeneratedTripDataset {
  const rng = createRng(options.seed);
  const nextId = createIdFactory(rng);

  const tripId = nextId();

  // --- places -------------------------------------------------------------

  const placesByKey = new Map<string, GeneratedPlace>();

  for (const place of spec.places) {
    if (placesByKey.has(place.key)) {
      throw new Error(`Duplicate place key "${place.key}"`);
    }

    placesByKey.set(place.key, {
      id: nextId(),
      key: place.key,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      address: place.address ?? null,
      sigmaMeters: resolveSigma(place, options.defaultSigmaMeters),
    });
  }

  // --- visits, in chronological order -------------------------------------

  interface ScheduledVisit {
    visit: GeneratedVisit;
    place: GeneratedPlace;
    spec: VisitSpec;
    arrivedMs: number;
    departedMs: number;
  }

  const scheduled: ScheduledVisit[] = spec.visits
    .map((visitSpec): ScheduledVisit => {
      const place = placesByKey.get(visitSpec.placeKey);
      if (!place) {
        throw new Error(`Visit refers to unknown place key "${visitSpec.placeKey}"`);
      }
      if (visitSpec.durationMinutes <= 0) {
        throw new Error(`Visit to "${visitSpec.placeKey}" needs a positive duration`);
      }

      const arrivedMs = localInstant(
        spec.startDate,
        visitSpec.day,
        visitSpec.arriveAt,
        spec.utcOffsetMinutes,
      );

      return {
        place,
        spec: visitSpec,
        arrivedMs,
        departedMs: arrivedMs + visitSpec.durationMinutes * MINUTE_MS,
        // `id` and `sequence` are filled in once the list is sorted.
        visit: { id: "", placeId: place.id, arrivedAt: "", departedAt: "", sequence: -1 },
      };
    })
    .sort((a, b) => a.arrivedMs - b.arrivedMs);

  scheduled.forEach((entry, index) => {
    entry.visit = {
      id: nextId(),
      placeId: entry.place.id,
      arrivedAt: toIso(entry.arrivedMs),
      departedAt: toIso(entry.departedMs),
      sequence: index,
    };
  });

  for (let i = 1; i < scheduled.length; i += 1) {
    const previous = scheduled[i - 1];
    const current = scheduled[i];
    if (previous && current && current.arrivedMs < previous.departedMs) {
      throw new Error(
        `Visits overlap: "${previous.spec.placeKey}" is still in progress when ` +
          `"${current.spec.placeKey}" begins`,
      );
    }
  }

  // --- photos -------------------------------------------------------------

  const drafts: PhotoDraft[] = [];

  const makeDraft = (params: {
    takenMs: number;
    position: LatLng | null;
    origin: PhotoOrigin;
    placeId: string | null;
    visitId: string | null;
    trueDistanceMeters: number | null;
  }): PhotoDraft => {
    const id = nextId();
    const shape = rng.pick(PHOTO_SHAPES);
    const cloudinaryId = `roam/${spec.slug}/${id}`;

    return {
      photo: {
        id,
        tripId,
        visitId: null,
        cloudinaryId,
        url: `https://res.cloudinary.com/${options.cloudName}/image/upload/f_auto,q_auto/${cloudinaryId}.jpg`,
        width: shape.width,
        height: shape.height,
        blurhash: rng.next() < BLURHASH_MISSING_RATE ? null : rng.pick(BLURHASH_POOL),
        takenAt: toIso(params.takenMs),
        lat: params.position ? roundCoordinate(params.position.lat) : null,
        lng: params.position ? roundCoordinate(params.position.lng) : null,
        gpsSource: params.position ? "EXIF" : "NONE",
      },
      assignment: {
        photoId: id,
        origin: params.origin,
        placeId: params.placeId,
        visitId: params.visitId,
        gpsStripped: false,
        trueDistanceMeters: params.trueDistanceMeters,
      },
    };
  };

  // Photos taken during each stay.
  for (const entry of scheduled) {
    const center: LatLng = { lat: entry.place.lat, lng: entry.place.lng };
    const stamps = burstTimestamps(
      rng,
      entry.spec.photoCount,
      entry.arrivedMs,
      entry.departedMs,
    );

    for (const takenMs of stamps) {
      const position = scatter(rng, center, entry.place.sigmaMeters);

      drafts.push(
        makeDraft({
          takenMs,
          position,
          origin: "place",
          placeId: entry.place.id,
          visitId: entry.visit.id,
          trueDistanceMeters: Number(haversineDistance(center, position).toFixed(2)),
        }),
      );
    }
  }

  // Sparse photos strung along the route between consecutive stops. These have
  // real coordinates but belong to no place, so a clusterer has to leave them
  // unassigned rather than drag them into the nearest cluster.
  for (let i = 1; i < scheduled.length; i += 1) {
    const previous = scheduled[i - 1];
    const current = scheduled[i];
    if (!previous || !current) continue;

    const gapMs = current.arrivedMs - previous.departedMs;
    if (
      gapMs < TRANSIT_MIN_GAP_MINUTES * MINUTE_MS ||
      gapMs > TRANSIT_MAX_GAP_MINUTES * MINUTE_MS
    ) {
      continue;
    }

    if (rng.next() < TRANSIT_EMPTY_CHANCE) continue;

    const from: LatLng = { lat: previous.place.lat, lng: previous.place.lng };
    const to: LatLng = { lat: current.place.lat, lng: current.place.lng };

    const count = rng.int(1, TRANSIT_MAX_PHOTOS);
    const fractions = Array.from({ length: count }, () => rng.next()).sort(
      (a, b) => a - b,
    );

    for (const t of fractions) {
      const position = scatter(rng, interpolate(from, to, t), TRANSIT_SIGMA_METERS);

      drafts.push(
        makeDraft({
          takenMs: Math.round(previous.departedMs + t * gapMs),
          position,
          origin: "transit",
          placeId: null,
          visitId: null,
          trueDistanceMeters: null,
        }),
      );
    }
  }

  // Day trips well outside the city. Exempt from the GPS stripping below — a
  // stripped outlier is no longer a spatial outlier, and these two exist
  // precisely to test that far-flung points are not swallowed by a cluster.
  const outlierIds = new Set<string>();

  for (const outlier of spec.outliers) {
    const draft = makeDraft({
      takenMs: localInstant(spec.startDate, outlier.day, outlier.takenAt, spec.utcOffsetMinutes),
      position: { lat: outlier.lat, lng: outlier.lng },
      origin: "outlier",
      placeId: null,
      visitId: null,
      trueDistanceMeters: null,
    });

    outlierIds.add(draft.photo.id);
    drafts.push(draft);
  }

  // --- strip GPS from a slice of the roll ---------------------------------
  //
  // Screenshots, photos taken with location services off, images that went
  // through an app which dropped the EXIF. The ground truth still records where
  // they were really taken, so timestamp-based recovery can be scored.

  const strippable = drafts.filter((draft) => !outlierIds.has(draft.photo.id));
  const stripTarget = Math.round(strippable.length * options.gpsStripRate);

  // Fisher-Yates over a copy, so the choice is uniform and reproducible.
  const shuffled = [...strippable];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const a = shuffled[i];
    const b = shuffled[j];
    if (a && b) {
      shuffled[i] = b;
      shuffled[j] = a;
    }
  }

  for (const draft of shuffled.slice(0, stripTarget)) {
    draft.photo.lat = null;
    draft.photo.lng = null;
    draft.photo.gpsSource = "NONE";
    draft.assignment.gpsStripped = true;
  }

  // --- assemble -----------------------------------------------------------

  // Chronological, which is the order an importer walks a camera roll in.
  drafts.sort((a, b) => {
    const left = a.photo.takenAt ?? "";
    const right = b.photo.takenAt ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const photos = drafts.map((draft) => draft.photo);
  const assignments = drafts.map((draft) => draft.assignment);

  const photosByOrigin: Record<PhotoOrigin, number> = { place: 0, transit: 0, outlier: 0 };
  for (const assignment of assignments) {
    photosByOrigin[assignment.origin] += 1;
  }

  const tripStartMs = localInstant(spec.startDate, 0, "00:00", spec.utcOffsetMinutes);
  const lastPhoto = photos.at(-1);
  const tripEndMs = lastPhoto?.takenAt
    ? new Date(lastPhoto.takenAt).getTime()
    : tripStartMs + DAY_MS;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      seed: options.seed,
      defaultSigmaMeters: options.defaultSigmaMeters,
      gpsStripRate: options.gpsStripRate,
      photoCount: photos.length,
      placeCount: placesByKey.size,
      visitCount: scheduled.length,
      photosByOrigin,
      photosWithoutGps: photos.filter((photo) => photo.lat === null).length,
    },
    trip: {
      id: tripId,
      name: spec.name,
      slug: spec.slug,
      startDate: toIso(tripStartMs),
      endDate: toIso(tripEndMs),
      utcOffsetMinutes: spec.utcOffsetMinutes,
    },
    photos,
    groundTruth: {
      places: [...placesByKey.values()],
      visits: scheduled.map((entry) => entry.visit),
      assignments,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Usage: tsx scripts/generate-trip.ts --city <slug> [options]

  --city <slug>         Itinerary to generate from ${ITINERARY_DIR}
                                                    (default: ${DEFAULT_CITY})
  --out <path>          Where to write the dataset
                                                    (default: data/<slug>-trip.json)
  --seed <int>          PRNG seed                   (default: ${DEFAULT_SEED})
  --sigma <metres>      Default GPS noise sigma for places that do not set
                        their own                   (default: ${DEFAULT_SIGMA_METERS})
  --strip-rate <0..1>   Fraction of photos that lose their coordinates
                                                    (default: ${DEFAULT_GPS_STRIP_RATE})
  --cloud-name <name>   Cloudinary cloud name used to build photo URLs
                                                    (default: ${DEFAULT_CLOUD_NAME})
  --help                Show this message
`.trimStart();

function parseNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
  isValid: (value: number) => boolean,
): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !isValid(value)) {
    throw new Error(`Invalid --${label}: "${raw}"`);
  }
  return value;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      out: { type: "string" },
      seed: { type: "string" },
      sigma: { type: "string" },
      "strip-rate": { type: "string" },
      "cloud-name": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const options: GeneratorOptions = {
    seed: parseNumber(values.seed, DEFAULT_SEED, "seed", Number.isInteger),
    defaultSigmaMeters: parseNumber(
      values.sigma,
      DEFAULT_SIGMA_METERS,
      "sigma",
      (value) => value > 0,
    ),
    gpsStripRate: parseNumber(
      values["strip-rate"],
      DEFAULT_GPS_STRIP_RATE,
      "strip-rate",
      (value) => value >= 0 && value <= 1,
    ),
    cloudName: values["cloud-name"] ?? DEFAULT_CLOUD_NAME,
  };

  const city = values.city ?? DEFAULT_CITY;
  const dataset = generate(loadItinerary(city), options);

  const outPath = resolve(process.cwd(), values.out ?? datasetPathFor(city));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

  const { meta } = dataset;
  process.stdout.write(
    [
      `Wrote ${outPath}`,
      `  trip     ${dataset.trip.name} (${dataset.trip.slug})`,
      `  seed     ${meta.seed}`,
      `  places   ${meta.placeCount}`,
      `  visits   ${meta.visitCount}`,
      `  photos   ${meta.photoCount}` +
        ` (${meta.photosByOrigin.place} at places,` +
        ` ${meta.photosByOrigin.transit} in transit,` +
        ` ${meta.photosByOrigin.outlier} outliers)`,
      `  no GPS   ${meta.photosWithoutGps}` +
        ` (${((meta.photosWithoutGps / meta.photoCount) * 100).toFixed(1)}%)`,
      "",
    ].join("\n"),
  );
}

// Only run when invoked as a script. Importing this module — from a test, or
// from a future seed script that wants `generate()` without a file write —
// must not write anything to disk.
const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined &&
  resolve(entry).replace(/\\/g, "/").endsWith("/scripts/generate-trip.ts");

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { DEFAULT_SIGMA_METERS, generate, loadItinerary };
export type { GeneratorOptions };
