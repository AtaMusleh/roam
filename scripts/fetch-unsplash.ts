/**
 * Builds the demo trip's photography cache from Unsplash.
 *
 *   UNSPLASH_ACCESS_KEY=... npx tsx scripts/fetch-unsplash.ts
 *
 * Searches Unsplash once per place per orientation, and writes the results to
 * `data/unsplash-rome.json`. That file is committed, so `seed-demo-trip.ts`
 * produces the same demo on any machine with no key and no network — which is
 * the point of caching it rather than fetching at seed time.
 *
 * Re-running is only necessary when the itinerary changes or the cache is
 * deleted. The free tier allows fifty requests an hour; a full run of the Rome
 * itinerary costs about twenty-four.
 *
 * Get a key by registering an application at https://unsplash.com/developers.
 */

// Must stay first: it populates the environment before anything reads it.
import "./load-env";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  GENERAL_BUCKET,
  GENERAL_QUERY,
  bucketQuery,
  orientationOf,
} from "../src/lib/unsplash-cache";
import type { UnsplashCache, UnsplashCacheBucket } from "../src/lib/unsplash-cache";
import { searchPhotos } from "../src/lib/unsplash";
import type { Orientation, UnsplashPhoto } from "../src/lib/unsplash";
import type { GeneratedTripDataset } from "../src/types";

const DEFAULT_DATA = "data/rome-trip.json";
const DEFAULT_OUT = "data/unsplash-rome.json";

/** Ceiling per place per orientation, so one big place cannot eat the budget. */
const MAX_PER_BUCKET = 40;

/**
 * Broader searches to fall back on when a place's own name finds too little.
 *
 * A place name is the best query when it works, and useless when it does not.
 * Measured against the first full fetch:
 *
 *  - "Sant'Eustachio Il Caffe Rome" returned **nothing**. It is a real café and
 *    a famous one, but the apostrophe and the exact trading name find no
 *    photographs at all.
 *  - "Piazza di Santa Maria in Trastevere Rome" returned **nothing** — too long
 *    and too specific a phrase for a search that matches on tags and titles.
 *  - "Foro Romano Rome" returned 21 of the 33 wanted, the Italian name being
 *    much thinner on Unsplash than the English one.
 *
 * Between them those three left 73 photographs with no picture. Each falls back
 * to something a photographer would plausibly have tagged.
 */
const FALLBACK_QUERIES: Readonly<Record<string, readonly string[]>> = {
  "sant-eustachio": ["Rome cafe", "Italian espresso bar"],
  trastevere: ["Trastevere Rome", "Trastevere street"],
  "roman-forum": ["Roman Forum ruins", "Ancient Rome ruins"],
};

const USAGE = `
Usage: UNSPLASH_ACCESS_KEY=... tsx scripts/fetch-unsplash.ts [options]

  --data <path>   Dataset to read the itinerary from  (default: ${DEFAULT_DATA})
  --out <path>    Cache file to write                 (default: ${DEFAULT_OUT})
  --help          Show this message
`.trimStart();

/** How many landscape and portrait photographs each place needs. */
function countByOrientation(
  dataset: GeneratedTripDataset,
): Map<string, { landscape: number; portrait: number }> {
  const placeKeyById = new Map(
    dataset.groundTruth.places.map((place) => [place.id, place.key]),
  );
  const assignmentByPhoto = new Map(
    dataset.groundTruth.assignments.map((a) => [a.photoId, a]),
  );

  const counts = new Map<string, { landscape: number; portrait: number }>();

  for (const photo of dataset.photos) {
    const placeId = assignmentByPhoto.get(photo.id)?.placeId ?? null;
    const key =
      placeId === null ? GENERAL_BUCKET : (placeKeyById.get(placeId) ?? GENERAL_BUCKET);

    const bucket = counts.get(key) ?? { landscape: 0, portrait: 0 };
    // Square counts as landscape; there is no third orientation to search for.
    if (orientationOf(photo.width, photo.height) === "portrait") bucket.portrait += 1;
    else bucket.landscape += 1;

    counts.set(key, bucket);
  }

  return counts;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!accessKey) {
    throw new Error(
      "UNSPLASH_ACCESS_KEY is not set.\n" +
        "Register an application at https://unsplash.com/developers, then:\n" +
        "  UNSPLASH_ACCESS_KEY=your-key npx tsx scripts/fetch-unsplash.ts\n" +
        "Until then the seed script falls back to --placeholder images.",
    );
  }

  const dataPath = resolve(process.cwd(), values.data ?? DEFAULT_DATA);
  const dataset = JSON.parse(
    readFileSync(dataPath, "utf8"),
  ) as GeneratedTripDataset;

  const nameByKey = new Map(
    dataset.groundTruth.places.map((place) => [place.key, place.name]),
  );

  const counts = countByOrientation(dataset);
  const buckets: Record<string, UnsplashCacheBucket> = {};

  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  out(`Fetching photography for ${counts.size} buckets`);

  let remaining: number | null = null;

  for (const [key, needed] of counts) {
    const query =
      key === GENERAL_BUCKET
        ? GENERAL_QUERY
        : bucketQuery(nameByKey.get(key) ?? key);

    const wanted: Record<Orientation, number> = {
      landscape: Math.min(needed.landscape, MAX_PER_BUCKET),
      portrait: Math.min(needed.portrait, MAX_PER_BUCKET),
    };

    // The place's own name first, then progressively broader searches. Each is
    // only run if the ones before it left the bucket short, so a query that
    // works costs nothing extra.
    const queries = [query, ...(FALLBACK_QUERIES[key] ?? [])];

    const bucket: UnsplashCacheBucket = { queries: [], landscape: [], portrait: [] };
    const used = new Set<string>();

    for (const orientation of ["landscape", "portrait"] as const) {
      if (wanted[orientation] === 0) continue;

      // Keyed by photo id, so a photograph found by two different searches is
      // kept once.
      const collected = new Map<string, UnsplashPhoto>();

      for (const attempt of queries) {
        if (collected.size >= wanted[orientation]) break;

        const result = await searchPhotos({
          query: attempt,
          orientation,
          count: wanted[orientation] - collected.size,
          accessKey,
        });

        for (const photo of result.photos) collected.set(photo.id, photo);
        remaining = result.remaining;
        used.add(attempt);

        if (attempt !== query) {
          out(
            `    "${attempt}" (${orientation}) added ${result.photos.length}, ` +
              `now ${collected.size}/${wanted[orientation]}`,
          );
        }
      }

      bucket[orientation] = [...collected.values()];
    }

    bucket.queries = queries.filter((candidate) => used.has(candidate));
    buckets[key] = bucket;

    out(
      `  ${query.padEnd(34)} ` +
        `${String(bucket.landscape.length).padStart(2)} landscape, ` +
        `${String(bucket.portrait.length).padStart(2)} portrait` +
        (remaining === null ? "" : `   (${remaining} requests left this hour)`),
    );

    // Still short after every fallback. Not fatal: the seed cycles what it has
    // and, for a bucket that is empty even now, borrows from the nearest place
    // it does have photographs for — so no photo is ever left without one.
    if (
      bucket.landscape.length < wanted.landscape ||
      bucket.portrait.length < wanted.portrait
    ) {
      const total = bucket.landscape.length + bucket.portrait.length;
      out(
        `    short of ${wanted.landscape} landscape / ${wanted.portrait} portrait` +
          (total === 0
            ? "; empty, the seed will borrow from the nearest place"
            : "; the seed will repeat photographs to fill in"),
      );
    }
  }

  const cache: UnsplashCache = {
    generatedAt: new Date().toISOString(),
    buckets,
  };

  const outPath = resolve(process.cwd(), values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

  const total = Object.values(buckets).reduce(
    (sum, bucket) => sum + bucket.landscape.length + bucket.portrait.length,
    0,
  );

  out();
  out(`Wrote ${outPath}`);
  out(`  ${total} photographs across ${Object.keys(buckets).length} buckets`);
  out("  Commit this file so the demo seeds without a key.");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
