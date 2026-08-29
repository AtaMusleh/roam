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

import { ingestTrip } from "../src/lib/ingest";
import { prisma } from "../src/lib/prisma";
import type { GeneratedPhoto, GeneratedTripDataset } from "../src/types";

const DEFAULT_DATA = "data/rome-trip.json";
const DEMO_SLUG = "rome-may-2026";

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
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  gpsSource: GeneratedPhoto["gpsSource"];
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
                      dataset's Cloudinary URLs, which point at nothing yet
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
      isPublic: true,
    },
  });

  const rows: PhotoRow[] = dataset.photos.map((photo) => {
    const image = values.placeholder
      ? placeholderPhoto(photo)
      : { url: photo.url, width: photo.width, height: photo.height };

    return {
      id: photo.id,
      tripId: trip.id,
      cloudinaryId: photo.cloudinaryId,
      url: image.url,
      width: image.width,
      height: image.height,
      blurhash: photo.blurhash,
      takenAt: photo.takenAt === null ? null : new Date(photo.takenAt),
      lat: photo.lat,
      lng: photo.lng,
      gpsSource: photo.gpsSource,
    };
  });

  await prisma.photo.createMany({ data: rows });
  out(
    `  inserted ${rows.length} photos` +
      (values.placeholder ? " with picsum.photos placeholders" : ""),
  );

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
