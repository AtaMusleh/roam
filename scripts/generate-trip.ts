/**
 * Synthetic trip generator.
 *
 *   npx tsx scripts/generate-trip.ts
 *   npx tsx scripts/generate-trip.ts --seed 7 --sigma 30 --out data/rome-trip.json
 *
 * Produces a photo dataset shaped like a real camera roll after a week in a
 * city, together with the ground truth — which photo was really taken at which
 * place — so clustering accuracy can be scored against it later.
 *
 * What makes the dataset hard, on purpose:
 *
 *  - Gaussian GPS noise around each place, with a per-place sigma. A café gets
 *    8m; a hillside archaeological site gets 55m.
 *  - Two places 90m apart (the Pantheon and the café on the next piazza), which
 *    a naive distance threshold will merge.
 *  - Sparse photos strung along the route between consecutive stops, which
 *    belong to no cluster at all.
 *  - ~15% of photos carry no coordinates, so their place has to be recovered
 *    from timestamps alone.
 *  - Two revisits: the same café on Monday and Thursday, the same square on
 *    Tuesday night and Friday afternoon. One place, two visits — clustering on
 *    position alone will collapse them.
 *  - Two genuine outliers, day trips 25-30km outside the city, which must not
 *    be absorbed into the nearest cluster.
 *
 * Everything is driven by a seeded PRNG, so the same seed always produces the
 * same dataset and accuracy numbers stay comparable between runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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

const DEFAULT_OUT = "data/rome-trip.json";

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
const HOUR_MS = 3_600_000;
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
 * stays dependency-free. Rome in May is UTC+2 throughout, so nothing is lost
 * for the built-in itinerary; a trip spanning a DST boundary would need a real
 * timezone library.
 */
function localInstant(
  startDate: string,
  dayOffset: number,
  timeOfDay: string,
  utcOffsetHours: number,
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
    utcOffsetHours * HOUR_MS
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
 * Five days in Rome, May 2026. Coordinates are the real ones; per-place sigmas
 * reflect how spread out each site actually is — you photograph the Trevi
 * Fountain from one small piazza, but the Forum from anywhere across nine
 * hectares of ruins.
 */
const ROME_TRIP: TripSpec = {
  name: "Rome, May 2026",
  slug: "rome-may-2026",
  startDate: "2026-05-11",
  utcOffsetHours: 2,

  places: [
    {
      key: "pantheon",
      name: "Pantheon",
      lat: 41.8986,
      lng: 12.4769,
      address: "Piazza della Rotonda, 00186 Roma",
      sigmaMeters: 18,
    },
    {
      // 90m from the Pantheon: the deliberate near-collision in this dataset.
      key: "sant-eustachio",
      name: "Sant'Eustachio Il Caffe",
      lat: 41.8987,
      lng: 12.4757,
      address: "Piazza di Sant'Eustachio 82, 00186 Roma",
      sigmaMeters: 8,
    },
    {
      key: "piazza-navona",
      name: "Piazza Navona",
      lat: 41.8992,
      lng: 12.4731,
      address: "Piazza Navona, 00186 Roma",
      sigmaMeters: 40,
    },
    {
      key: "campo-de-fiori",
      name: "Campo de' Fiori",
      lat: 41.8956,
      lng: 12.4722,
      address: "Piazza Campo de' Fiori, 00186 Roma",
      sigmaMeters: 25,
    },
    {
      key: "colosseum",
      name: "Colosseo",
      lat: 41.8902,
      lng: 12.4922,
      address: "Piazza del Colosseo 1, 00184 Roma",
      sigmaMeters: 45,
    },
    {
      key: "roman-forum",
      name: "Foro Romano",
      lat: 41.8925,
      lng: 12.4853,
      address: "Via della Salara Vecchia 5/6, 00186 Roma",
      sigmaMeters: 60,
    },
    {
      key: "palatine-hill",
      name: "Palatino",
      lat: 41.8887,
      lng: 12.4875,
      address: "Via di San Gregorio 30, 00186 Roma",
      sigmaMeters: 55,
    },
    {
      key: "trastevere",
      name: "Piazza di Santa Maria in Trastevere",
      lat: 41.8893,
      lng: 12.4695,
      address: "Piazza di Santa Maria in Trastevere, 00153 Roma",
      sigmaMeters: 25,
    },
    {
      key: "vatican-museums",
      name: "Musei Vaticani",
      lat: 41.9065,
      lng: 12.4536,
      address: "Viale Vaticano, 00165 Roma",
      sigmaMeters: 35,
    },
    {
      key: "st-peters",
      name: "Basilica di San Pietro",
      lat: 41.9022,
      lng: 12.4539,
      address: "Piazza San Pietro, 00120 Citta del Vaticano",
      sigmaMeters: 50,
    },
    {
      key: "castel-santangelo",
      name: "Castel Sant'Angelo",
      lat: 41.9031,
      lng: 12.4663,
      address: "Lungotevere Castello 50, 00193 Roma",
      sigmaMeters: 30,
    },
    {
      key: "trevi",
      name: "Fontana di Trevi",
      lat: 41.9009,
      lng: 12.4833,
      address: "Piazza di Trevi, 00187 Roma",
      sigmaMeters: 15,
    },
  ],

  visits: [
    // Day 1 — the centro storico on foot.
    { placeKey: "pantheon", day: 0, arriveAt: "10:15", durationMinutes: 45, photoCount: 22 },
    { placeKey: "sant-eustachio", day: 0, arriveAt: "11:10", durationMinutes: 35, photoCount: 9 },
    { placeKey: "piazza-navona", day: 0, arriveAt: "12:00", durationMinutes: 50, photoCount: 18 },
    { placeKey: "campo-de-fiori", day: 0, arriveAt: "13:10", durationMinutes: 60, photoCount: 14 },

    // Day 2 — ancient Rome, then dinner across the river.
    { placeKey: "colosseum", day: 1, arriveAt: "09:30", durationMinutes: 100, photoCount: 41 },
    { placeKey: "roman-forum", day: 1, arriveAt: "11:30", durationMinutes: 95, photoCount: 33 },
    { placeKey: "palatine-hill", day: 1, arriveAt: "13:15", durationMinutes: 70, photoCount: 21 },
    { placeKey: "trastevere", day: 1, arriveAt: "19:30", durationMinutes: 120, photoCount: 26 },

    // Day 3 — the Vatican.
    { placeKey: "vatican-museums", day: 2, arriveAt: "08:45", durationMinutes: 180, photoCount: 58 },
    { placeKey: "st-peters", day: 2, arriveAt: "12:15", durationMinutes: 110, photoCount: 37 },
    { placeKey: "castel-santangelo", day: 2, arriveAt: "14:40", durationMinutes: 65, photoCount: 19 },

    // Day 4 — back to the same café, three days on. Revisit #1.
    { placeKey: "sant-eustachio", day: 3, arriveAt: "09:20", durationMinutes: 30, photoCount: 7 },
    { placeKey: "trevi", day: 3, arriveAt: "10:10", durationMinutes: 55, photoCount: 29 },

    // Day 5 — a long last lunch in Tuesday night's square. Revisit #2.
    { placeKey: "trastevere", day: 4, arriveAt: "12:30", durationMinutes: 140, photoCount: 31 },
  ],

  outliers: [
    { name: "Ostia Antica", lat: 41.7556, lng: 12.2917, day: 3, takenAt: "16:40" },
    { name: "Villa d'Este, Tivoli", lat: 41.9631, lng: 12.7958, day: 4, takenAt: "09:05" },
  ],
};

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
        spec.utcOffsetHours,
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
      takenMs: localInstant(spec.startDate, outlier.day, outlier.takenAt, spec.utcOffsetHours),
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

  const tripStartMs = localInstant(spec.startDate, 0, "00:00", spec.utcOffsetHours);
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
Usage: tsx scripts/generate-trip.ts [options]

  --out <path>          Where to write the dataset  (default: ${DEFAULT_OUT})
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

  const dataset = generate(ROME_TRIP, options);

  const outPath = resolve(process.cwd(), values.out ?? DEFAULT_OUT);
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

export { DEFAULT_SIGMA_METERS, generate, ROME_TRIP };
export type { GeneratorOptions };
