/**
 * Seeds one public demo trip.
 *
 *   npx tsx scripts/seed-demo-trip.ts --city rome --placeholder
 *   npx tsx scripts/seed-demo-trip.ts --city athens --no-geocode
 *   npx tsx scripts/seed-demo-trip.ts --city lisbon --force-geocode
 *
 * Loads `data/<city>-trip.json`, creates the trip, inserts its photos, and runs
 * the clustering ingest over them. The result is a browsable trip with named
 * places and ordered visits, which is what everything downstream — the map,
 * the timeline — is built against.
 *
 * Slug, dates and UTC offset all come from the dataset, which carries them
 * through from `data/itineraries/<city>.json`. Nothing about a particular city
 * is hard-coded here.
 *
 * Re-runnable. The existing trip with this slug is deleted first, so the
 * unique constraint never fires and each run starts from a clean state.
 *
 * `seedCity` is exported so `seed-all.ts` can run every city inside one
 * process — which matters, because the Nominatim rate limiter is per-process
 * and seeding cities in separate processes would let them talk over each other.
 */

// Must stay first: it populates DATABASE_URL before the Prisma client below is
// imported, and that client throws at import time without it.
import "./load-env";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { haversineDistance } from "../src/lib/geo";
import { ingestTrip } from "../src/lib/ingest";
import {
  GENERAL_BUCKET,
  orientationOf,
  pickFromBucket,
} from "../src/lib/unsplash-cache";
import type { UnsplashCache } from "../src/lib/unsplash-cache";
import { prisma } from "../src/lib/prisma";
import type { GeneratedPhoto, GeneratedTripDataset } from "../src/types";

/** The city seeded when none is named. */
const DEFAULT_CITY = "rome";

function datasetPathFor(city: string): string {
  return `data/${city}-trip.json`;
}

function cachePathFor(city: string): string {
  return `data/unsplash-${city}.json`;
}

/**
 * Longest edge of a placeholder image. The dataset's real dimensions are phone
 * sized (4032px), which picsum will not serve and nobody needs for a demo.
 */
const PLACEHOLDER_MAX_EDGE = 1200;

interface PhotoRow {
  id: string;
  tripId: string;
  cloudinaryId: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  gpsSource: GeneratedPhoto["gpsSource"];
}

/** What an image source decided about one photograph. */
interface ImageChoice {
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
}

function readUnsplashCache(path: string): UnsplashCache | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UnsplashCache;
  } catch {
    // Absent or unreadable is a normal state — the cache only exists once
    // someone with a key has run scripts/fetch-unsplash.ts.
    return null;
  }
}

/**
 * A stable stand-in image per photo.
 *
 * `picsum.photos/seed/<seed>` always returns the same picture for the same
 * seed, so the demo looks identical on every run and across machines — which
 * matters when the point is to eyeball whether clustering grouped sensibly.
 * Aspect ratio is preserved from the real photo so the layout is honest even
 * though the pixels are not.
 */
function placeholderPhoto(photo: GeneratedPhoto): {
  url: string;
  width: number;
  height: number;
} {
  const scale = Math.min(1, PLACEHOLDER_MAX_EDGE / Math.max(photo.width, photo.height));
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));

  return {
    url: `https://picsum.photos/seed/${photo.id}/${width}/${height}`,
    width,
    height,
  };
}

const USAGE = `
Usage: tsx scripts/seed-demo-trip.ts [options]

  --city <slug>       Which city to seed        (default: ${DEFAULT_CITY})
  --data <path>       Dataset to seed from      (default: data/<city>-trip.json)
  --placeholder       Use deterministic picsum.photos images instead of the
                      Unsplash cache. Subjects are random, so this is only a
                      stand-in for when no cache has been fetched
  --unsplash-cache <path>
                      Photography cache to read (default: data/unsplash-<city>.json)
  --no-geocode        Name places by coordinates, skipping the lookups entirely
  --force-geocode     Ignore cached names and look every place up again, for
                      testing changes to the naming rules
  --epsilon <metres>  DBSCAN radius             (default: pipeline default, 60)
  --min-points <int>  DBSCAN core threshold     (default: pipeline default, 4)
  --help              Show this message
`.trimStart();

/** Everything `seedCity` needs; every field but `city` has a sensible default. */
export interface SeedCityOptions {
  city: string;
  /** Overrides `data/<city>-trip.json`. */
  dataPath?: string;
  /** Overrides `data/unsplash-<city>.json`. */
  cachePath?: string;
  /** Use picsum stand-ins rather than the Unsplash cache. */
  placeholder?: boolean;
  /** Name places by lookup rather than by coordinates. Defaults to true. */
  geocode?: boolean;
  /** Ignore cached names and look every place up again. */
  forceGeocode?: boolean;
  epsilonMeters?: number;
  minPoints?: number;
  /** Where progress goes. Defaults to stdout. */
  log?: (text?: string) => void;
}

/** What one city's seed produced, for `seed-all` to summarise across cities. */
export interface SeedCitySummary {
  city: string;
  slug: string;
  photos: number;
  places: number;
  visits: number;
  /** Photographs left pointing at an image that will not load. */
  broken: number;
}

function parseNumber(
  raw: string | undefined,
  label: string,
  isValid: (value: number) => boolean,
): number | undefined {
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value) || !isValid(value)) {
    throw new Error(`Invalid --${label}: "${raw}"`);
  }
  return value;
}

export async function seedCity(
  options: SeedCityOptions,
): Promise<SeedCitySummary> {
  const { city } = options;
  const placeholder = options.placeholder ?? false;

  const dataPath = resolve(
    process.cwd(),
    options.dataPath ?? datasetPathFor(city),
  );
  const dataset = JSON.parse(
    readFileSync(dataPath, "utf8"),
  ) as GeneratedTripDataset;

  const out =
    options.log ??
    ((text = ""): void => {
      process.stdout.write(`${text}\n`);
    });

  out(`Seeding from ${dataPath}`);
  out(`  ${dataset.photos.length} photos, trip "${dataset.trip.name}"`);

  // --- reset ---------------------------------------------------------------
  //
  // Deleting the trip cascades to its places, visits and photos, so this is a
  // complete reset rather than a partial overwrite. Re-running the script is
  // therefore safe, and never trips the unique constraint on `slug`.

  const slug = dataset.trip.slug;

  const existing = await prisma.trip.findUnique({ where: { slug } });
  if (existing) {
    await prisma.trip.delete({ where: { id: existing.id } });
    out(`  removed the previous "${slug}" trip`);
  }

  // --- trip and photos -----------------------------------------------------

  const trip = await prisma.trip.create({
    data: {
      name: dataset.trip.name,
      slug,
      startDate: new Date(dataset.trip.startDate),
      endDate: new Date(dataset.trip.endDate),
      // Carried through from the itinerary. The dataset is synthetic, so this
      // is declared rather than measured; a real import derives it from EXIF —
      // see the note in `src/lib/format.ts`.
      utcOffsetMinutes: dataset.trip.utcOffsetMinutes,
      isPublic: true,
    },
  });

  // --- choose an image for every photograph ---------------------------------
  //
  // Two sources, in descending order of how good the demo looks:
  //
  //  1. The Unsplash cache — real photographs of the actual places, which is
  //     the only one that makes the demo worth showing anyone.
  //  2. picsum.photos placeholders. Stable per photo, but random subjects: the
  //     Colosseum gets a waterfall.
  //
  // The dataset's own Cloudinary URLs are deliberately *not* a source. They
  // point at an account with nothing uploaded to it, so every one of them is a
  // broken image; a random photograph of the wrong thing at least renders.

  const cachePath = resolve(process.cwd(), options.cachePath ?? cachePathFor(city));
  const cache = placeholder ? null : readUnsplashCache(cachePath);

  if (cache) {
    out(`  using photography from ${cachePath}`);
  } else if (!placeholder) {
    out(`  no Unsplash cache at ${cachePath} — using picsum.photos placeholders`);
    out(`  Run: UNSPLASH_ACCESS_KEY=... npx tsx scripts/fetch-unsplash.ts --city ${city}`);
  }

  // Ground truth tells us which place each photograph belongs to, so each one
  // can be given a picture of the right place.
  const placeKeyById = new Map(
    dataset.groundTruth.places.map((place) => [place.id, place.key]),
  );
  const assignmentByPhoto = new Map(
    dataset.groundTruth.assignments.map((a) => [a.photoId, a]),
  );
  const coordsByKey = new Map(
    dataset.groundTruth.places.map((place) => [
      place.key,
      { lat: place.lat, lng: place.lng },
    ]),
  );

  const hasPhotos = (key: string): boolean => {
    const bucket = cache?.buckets[key];
    return bucket !== undefined && bucket.landscape.length + bucket.portrait.length > 0;
  };

  const coveredKeys = cache ? Object.keys(cache.buckets).filter(hasPhotos) : [];

  /**
   * The bucket a place's photographs actually come from.
   *
   * Normally itself. When a search found nothing for it even after the
   * fallbacks — Sant'Eustachio and the Trastevere piazza both came back empty —
   * its photographs are borrowed from the *nearest* place that does have some.
   * A picture of the next square along is not the right building, but it is
   * Rome, it is correctly credited, and it renders. Leaving the Cloudinary URL
   * in place would leave a broken image, which is worse in every way.
   */
  const donorCache = new Map<string, string | null>();

  const resolveDonor = (key: string): string | null => {
    const memoised = donorCache.get(key);
    if (memoised !== undefined) return memoised;

    let donor: string | null = null;

    if (hasPhotos(key)) {
      donor = key;
    } else {
      const here = coordsByKey.get(key);

      if (here) {
        let nearest = Number.POSITIVE_INFINITY;

        for (const candidate of coveredKeys) {
          const there = coordsByKey.get(candidate);
          if (!there) continue;

          const distance = haversineDistance(here, there);
          if (distance < nearest) {
            nearest = distance;
            donor = candidate;
          }
        }
      }

      // Nothing to measure against — the general bucket has no coordinates, and
      // neither does a place missing from the ground truth. Take whichever
      // covered bucket has the most to give.
      donor ??=
        coveredKeys
          .map((candidate) => ({
            candidate,
            size:
              (cache?.buckets[candidate]?.landscape.length ?? 0) +
              (cache?.buckets[candidate]?.portrait.length ?? 0),
          }))
          .sort((a, b) => b.size - a.size)[0]?.candidate ?? null;
    }

    donorCache.set(key, donor);
    return donor;
  };

  /** Per-bucket, per-orientation counters, so photographs are dealt in turn. */
  const dealt = new Map<string, number>();
  let borrowed = 0;

  const chooseImage = (photo: GeneratedPhoto): ImageChoice => {
    if (cache) {
      const placeId = assignmentByPhoto.get(photo.id)?.placeId ?? null;
      const key =
        placeId === null
          ? GENERAL_BUCKET
          : (placeKeyById.get(placeId) ?? GENERAL_BUCKET);

      const donor = resolveDonor(key);

      if (donor !== null) {
        if (donor !== key) borrowed += 1;

        const orientation = orientationOf(photo.width, photo.height);
        // Counted against the donor, so borrowing places and the donor itself
        // deal from the same pack rather than all starting at the first photo.
        const counterKey = `${donor}:${orientation}`;
        const index = dealt.get(counterKey) ?? 0;
        dealt.set(counterKey, index + 1);

        const chosen = pickFromBucket(cache.buckets[donor], orientation, index);

        if (chosen) {
          return {
            url: chosen.url,
            // The real dimensions, so the aspect-ratio boxes in the grid reserve
            // exactly the right space for the image that will arrive.
            width: chosen.width,
            height: chosen.height,
            blurhash: chosen.blurhash,
            photographerName: chosen.photographerName,
            photographerUrl: chosen.photographerUrl,
          };
        }
      }
    }

    return {
      ...placeholderPhoto(photo),
      blurhash: photo.blurhash,
      photographerName: null,
      photographerUrl: null,
    };
  };

  const rows: PhotoRow[] = dataset.photos.map((photo) => {
    const image = chooseImage(photo);

    return {
      id: photo.id,
      tripId: trip.id,
      cloudinaryId: photo.cloudinaryId,
      url: image.url,
      width: image.width,
      height: image.height,
      blurhash: image.blurhash,
      photographerName: image.photographerName,
      photographerUrl: image.photographerUrl,
      takenAt: photo.takenAt === null ? null : new Date(photo.takenAt),
      lat: photo.lat,
      lng: photo.lng,
      gpsSource: photo.gpsSource,
    };
  });

  await prisma.photo.createMany({ data: rows });

  const credited = rows.filter((row) => row.photographerName !== null).length;
  const dead = rows.filter((row) => row.url.includes("res.cloudinary.com")).length;

  const standIns = rows.length - credited;

  out(
    `  inserted ${rows.length} photos: ` +
      `${credited} from Unsplash (credited), ${standIns} picsum stand-ins`,
  );

  if (borrowed > 0) {
    out(
      `  ${borrowed} borrowed from the nearest covered place, ` +
        "because their own search found nothing",
    );
  }

  // Nothing should reach this any more — Cloudinary is no longer an image
  // source. Kept as a tripwire, because a broken image is easy to ship and
  // hard to notice among four hundred that work.
  if (dead > 0) {
    out(
      `  WARNING: ${dead} photos still point at unused Cloudinary URLs and will ` +
        "render broken.",
    );
  }

  // --- cluster -------------------------------------------------------------

  const geocode = options.geocode ?? true;
  const forceGeocode = options.forceGeocode ?? false;

  if (geocode) {
    out(
      forceGeocode
        ? "  naming places, ignoring the cache (several seconds each)..."
        : "  naming places (several seconds each on a cold cache)...",
    );
  }

  const started = Date.now();
  const result = await ingestTrip(trip.id, {
    epsilonMeters: options.epsilonMeters,
    minPoints: options.minPoints,
    geocode,
    forceGeocode,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  out();
  out(`Clustered in ${elapsed}s`);
  out(`  places            ${result.places.length}`);
  out(`  visits            ${result.visits.length}`);
  out(`  photos assigned   ${result.stats.photosAssigned}`);
  out(`  photos unassigned ${result.stats.photosUnassigned} (noise and unpositioned)`);
  out(`  interpolated      ${result.stats.photosInterpolated}`);
  if (geocode) {
    out(`  names geocoded    ${result.stats.placesNamed}/${result.places.length}`);
  }
  out();

  const visitsByPlace = new Map<string, number>();
  for (const visit of result.visits) {
    visitsByPlace.set(visit.placeId, (visitsByPlace.get(visit.placeId) ?? 0) + 1);
  }

  const ordered = [...result.places].sort((a, b) => b.photoCount - a.photoCount);
  const nameWidth = Math.max(...ordered.map((place) => place.name.length));

  for (const place of ordered) {
    const visits = visitsByPlace.get(place.id) ?? 0;
    out(
      `  ${place.name.padEnd(nameWidth)}  ` +
        `${String(place.photoCount).padStart(3)} photos  ` +
        `${visits} visit${visits === 1 ? " " : "s"}`,
    );
  }

  out();
  out(`Trip ready: /${slug} (public)`);

  return {
    city,
    slug,
    photos: rows.length,
    places: result.places.length,
    visits: result.visits.length,
    broken: dead,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      data: { type: "string" },
      placeholder: { type: "boolean", default: false },
      "no-geocode": { type: "boolean", default: false },
      "force-geocode": { type: "boolean", default: false },
      epsilon: { type: "string" },
      "min-points": { type: "string" },
      "unsplash-cache": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  await seedCity({
    city: values.city ?? DEFAULT_CITY,
    dataPath: values.data,
    cachePath: values["unsplash-cache"],
    placeholder: values.placeholder,
    geocode: !values["no-geocode"],
    forceGeocode: values["force-geocode"],
    epsilonMeters: parseNumber(values.epsilon, "epsilon", (v) => v > 0),
    minPoints: parseNumber(values["min-points"], "min-points", Number.isInteger),
  });
}

// Only when run directly. Importing this module for `seedCity` — which is
// exactly what `seed-all.ts` does — must not seed Rome as a side effect.
const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined &&
  resolve(entry).replace(/\\/g, "/").endsWith("/scripts/seed-demo-trip.ts");

if (invokedDirectly) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
