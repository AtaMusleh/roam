/**
 * Seeds the public demo trip.
 *
 *   npx tsx scripts/seed-demo-trip.ts --placeholder
 *   npx tsx scripts/seed-demo-trip.ts --no-geocode --epsilon 40 --min-points 5
 *   npx tsx scripts/seed-demo-trip.ts --placeholder --force-geocode
 *
 * Loads `data/rome-trip.json`, creates the trip, inserts its photos, and runs
 * the clustering ingest over them. The result is a browsable trip with named
 * places and ordered visits, which is what everything downstream — the map,
 * the timeline — will be built against.
 *
 * Re-runnable. The existing trip with this slug is deleted first, so the
 * unique constraint never fires and each run starts from a clean state.
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

const DEFAULT_DATA = "data/rome-trip.json";
const DEMO_SLUG = "rome-may-2026";

/**
 * Longest edge of a placeholder image. The dataset's real dimensions are phone
 * sized (4032px), which picsum will not serve and nobody needs for a demo.
 */
const PLACEHOLDER_MAX_EDGE = 1200;

const DEFAULT_UNSPLASH_CACHE = "data/unsplash-rome.json";

/**
 * The trip's UTC offset, in minutes. Rome in May is UTC+2.
 *
 * Hard-coded for the demo because the dataset is synthetic. A real import
 * derives it from EXIF — see the note in `src/lib/format.ts`.
 */
const ROME_UTC_OFFSET_MINUTES = 120;

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

  --data <path>       Dataset to seed from      (default: ${DEFAULT_DATA})
  --placeholder       Use deterministic picsum.photos images instead of the
                      Unsplash cache. Subjects are random, so this is only a
                      stand-in for when no cache has been fetched
  --unsplash-cache <path>
                      Photography cache to read   (default: ${DEFAULT_UNSPLASH_CACHE})
  --no-geocode        Name places by coordinates, skipping the lookups entirely
  --force-geocode     Ignore cached names and look every place up again, for
                      testing changes to the naming rules
  --epsilon <metres>  DBSCAN radius             (default: pipeline default, 60)
  --min-points <int>  DBSCAN core threshold     (default: pipeline default, 4)
  --help              Show this message
`.trimStart();

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
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

  const dataPath = resolve(process.cwd(), values.data ?? DEFAULT_DATA);
  const dataset = JSON.parse(
    readFileSync(dataPath, "utf8"),
  ) as GeneratedTripDataset;

  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  out(`Seeding from ${dataPath}`);
  out(`  ${dataset.photos.length} photos, trip "${dataset.trip.name}"`);

  // --- reset ---------------------------------------------------------------
  //
  // Deleting the trip cascades to its places, visits and photos, so this is a
  // complete reset rather than a partial overwrite. Re-running the script is
  // therefore safe, and never trips the unique constraint on `slug`.

  const existing = await prisma.trip.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    await prisma.trip.delete({ where: { id: existing.id } });
    out(`  removed the previous "${DEMO_SLUG}" trip`);
  }

  // --- trip and photos -----------------------------------------------------

  const trip = await prisma.trip.create({
    data: {
      name: dataset.trip.name,
      slug: DEMO_SLUG,
      startDate: new Date(dataset.trip.startDate),
      endDate: new Date(dataset.trip.endDate),
      utcOffsetMinutes: ROME_UTC_OFFSET_MINUTES,
      isPublic: true,
    },
  });

  // --- choose an image for every photograph ---------------------------------
  //
  // Three sources, in descending order of how good the demo looks:
  //
  //  1. The Unsplash cache — real photographs of the actual places, which is
  //     the only one that makes the demo worth showing anyone.
  //  2. picsum.photos placeholders, under --placeholder. Stable per photo, but
  //     random subjects: the Colosseum gets a waterfall.
  //  3. The dataset's Cloudinary URLs, which point at an account that has
  //     nothing uploaded to it yet.

  const cachePath = resolve(
    process.cwd(),
    values["unsplash-cache"] ?? DEFAULT_UNSPLASH_CACHE,
  );
  const cache = values.placeholder ? null : readUnsplashCache(cachePath);

  if (cache) {
    out(`  using photography from ${cachePath}`);
  } else if (!values.placeholder) {
    out(`  no Unsplash cache at ${cachePath}`);
    out("  falling back to the dataset's Cloudinary URLs, which resolve to nothing.");
    out("  Run: UNSPLASH_ACCESS_KEY=... npx tsx scripts/fetch-unsplash.ts");
    out("  ...or re-run this with --placeholder.");
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

    const fallback = values.placeholder
      ? placeholderPhoto(photo)
      : { url: photo.url, width: photo.width, height: photo.height };

    return {
      ...fallback,
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

  out(
    `  inserted ${rows.length} photos` +
      (credited > 0
        ? ` (${credited} from Unsplash, credited)`
        : values.placeholder
          ? " with picsum.photos placeholders"
          : ""),
  );

  if (borrowed > 0) {
    out(
      `  ${borrowed} borrowed from the nearest covered place, ` +
        "because their own search found nothing",
    );
  }

  // A Cloudinary URL in the demo is a broken image: that account has nothing
  // uploaded to it. Worth saying loudly rather than leaving to be discovered.
  if (dead > 0) {
    out(
      `  WARNING: ${dead} photos still point at unused Cloudinary URLs and will ` +
        "render broken. Re-run scripts/fetch-unsplash.ts, or pass --placeholder.",
    );
  }

  // --- cluster -------------------------------------------------------------

  const geocode = !values["no-geocode"];
  if (geocode) {
    out(
      values["force-geocode"]
        ? "  naming places, ignoring the cache (several seconds each)..."
        : "  naming places (several seconds each on a cold cache)...",
    );
  }

  const started = Date.now();
  const result = await ingestTrip(trip.id, {
    epsilonMeters: parseNumber(values.epsilon, "epsilon", (v) => v > 0),
    minPoints: parseNumber(values["min-points"], "min-points", Number.isInteger),
    geocode,
    forceGeocode: values["force-geocode"],
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
  out(`Demo trip ready: /${DEMO_SLUG} (public)`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
