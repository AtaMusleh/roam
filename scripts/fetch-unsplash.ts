/**
 * Builds a trip's photography cache from Unsplash.
 *
 *   UNSPLASH_ACCESS_KEY=... npx tsx scripts/fetch-unsplash.ts --city rome
 *
 * Searches Unsplash once per place per orientation, and writes the results to
 * `data/unsplash-<city>.json`. Those files are committed, so `seed-demo-trip.ts`
 * produces the same demo on any machine with no key and no network — which is
 * the point of caching them rather than fetching at seed time.
 *
 * Re-running is only necessary when an itinerary changes or a cache is deleted.
 *
 * ## The budget, and why this writes what it has
 *
 * The demo tier allows fifty requests an hour, and one city costs roughly
 * twenty-five. Four cities therefore cannot be fetched in one sitting. When the
 * budget runs out mid-run the buckets filled so far are still written, with the
 * ones left untouched simply absent — the seed borrows from the nearest covered
 * place for those. Re-running an hour later fills in the rest, merging into the
 * cache already on disk rather than starting again from nothing.
 *
 * Get a key by registering an application at https://unsplash.com/developers.
 */

// Must stay first: it populates the environment before anything reads it.
import "./load-env";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  GENERAL_BUCKET,
  bucketQuery,
  generalQuery,
  orientationOf,
} from "../src/lib/unsplash-cache";
import type { UnsplashCache, UnsplashCacheBucket } from "../src/lib/unsplash-cache";
import { UnsplashRateLimitError, searchPhotos } from "../src/lib/unsplash";
import type {
  Orientation,
  UnsplashPhoto,
  UnsplashSearchResult,
} from "../src/lib/unsplash";
import type { GeneratedTripDataset } from "../src/types";

const DEFAULT_CITY = "rome";

function datasetPathFor(city: string): string {
  return `data/${city}-trip.json`;
}

function cachePathFor(city: string): string {
  return `data/unsplash-${city}.json`;
}

/** Ceiling per place per orientation, so one big place cannot eat the budget. */
const MAX_PER_BUCKET = 40;

/**
 * Broader searches to fall back on when a place's own name finds too little.
 *
 * A place name is the best query when it works, and useless when it does not.
 * Measured against the first full Rome fetch:
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
 *
 * Keyed by place key, which is unique across itineraries, so one table serves
 * every city. The entries below Rome's are for the same failure modes in the
 * other three: a neighbourhood whose name is a local word rather than a tag
 * (Anafiotika, Bunkers del Carmel), a route rather than a building (Tram 28),
 * and names carrying diacritics that thin the results out (Barri Gòtic,
 * Montjuïc). A fallback only runs when the ones before it came up short, so
 * listing one for a place that turns out fine costs nothing.
 */
const FALLBACK_QUERIES: Readonly<Record<string, readonly string[]>> = {
  // Rome
  "sant-eustachio": ["Rome cafe", "Italian espresso bar"],
  trastevere: ["Trastevere Rome", "Trastevere street"],
  "roman-forum": ["Roman Forum ruins", "Ancient Rome ruins"],

  // Barcelona
  "bunkers-del-carmel": ["Barcelona viewpoint", "Barcelona skyline"],
  "gothic-quarter": ["Gothic Quarter Barcelona", "Barcelona old town"],
  montjuic: ["Montjuic Barcelona", "Barcelona hill view"],
  barceloneta: ["Barceloneta beach", "Barcelona beach"],
  "mercat-boqueria": ["Boqueria market", "Barcelona market"],

  // Lisbon
  "tram-28": ["Lisbon tram", "yellow tram Lisbon"],
  "senhora-do-monte": ["Lisbon viewpoint", "Lisbon miradouro"],
  "time-out-market": ["Lisbon market", "Lisbon food market"],
  "lx-factory": ["Lisbon street art", "Lisbon industrial"],
  "padrao-descobrimentos": ["Belem Lisbon", "Lisbon monument"],
  jeronimos: ["Jeronimos Monastery", "Belem Lisbon"],

  // Athens
  anafiotika: ["Plaka Athens", "Athens old town"],
  monastiraki: ["Monastiraki Athens", "Athens flea market"],
  "national-archaeological-museum": ["Athens museum", "Greek sculpture"],
  "temple-olympian-zeus": ["Temple of Zeus Athens", "Athens ruins"],
  lycabettus: ["Athens viewpoint", "Athens skyline"],
  syntagma: ["Syntagma Athens", "Athens square"],
};

const USAGE = `
Usage: UNSPLASH_ACCESS_KEY=... tsx scripts/fetch-unsplash.ts [options]

  --city <slug>   Which city to fetch for            (default: ${DEFAULT_CITY})
  --data <path>   Dataset to read the itinerary from (default: data/<slug>-trip.json)
  --out <path>    Cache file to write               (default: data/unsplash-<slug>.json)
  --refetch       Re-search buckets the cache already has
  --help          Show this message
`.trimStart();

/**
 * Reads the buckets already in a cache file, or none if there is no file yet.
 *
 * A run cut short by the hourly limit leaves a partial cache behind. Reading it
 * back means the next run picks up where that one stopped rather than spending
 * its first twenty requests re-fetching what is already on disk.
 */
function readExistingBuckets(path: string): Record<string, UnsplashCacheBucket> {
  if (!existsSync(path)) return {};

  const cache = JSON.parse(readFileSync(path, "utf8")) as UnsplashCache;
  return { ...cache.buckets };
}

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
      city: { type: "string" },
      data: { type: "string" },
      out: { type: "string" },
      refetch: { type: "boolean", default: false },
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

  const city = values.city ?? DEFAULT_CITY;
  const dataPath = resolve(process.cwd(), values.data ?? datasetPathFor(city));
  const dataset = JSON.parse(
    readFileSync(dataPath, "utf8"),
  ) as GeneratedTripDataset;

  const nameByKey = new Map(
    dataset.groundTruth.places.map((place) => [place.key, place.name]),
  );

  const counts = countByOrientation(dataset);
  const outPath = resolve(process.cwd(), values.out ?? cachePathFor(city));
  const buckets = values.refetch ? {} : readExistingBuckets(outPath);

  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  const already = Object.keys(buckets).filter((key) => counts.has(key)).length;

  out(
    `Fetching photography for ${city}: ${counts.size} buckets` +
      (already === 0 ? "" : `, ${already} already cached`),
  );

  let remaining: number | null = null;
  /** Set when Unsplash refuses on quota grounds, to stop and keep what we have. */
  let exhausted = false;

  for (const [key, needed] of counts) {
    if (key in buckets) continue;

    const query =
      key === GENERAL_BUCKET
        ? generalQuery(city)
        : bucketQuery(nameByKey.get(key) ?? key, city);

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

        let result: UnsplashSearchResult;

        try {
          result = await searchPhotos({
            query: attempt,
            orientation,
            count: wanted[orientation] - collected.size,
            accessKey,
          });
        } catch (error) {
          // Anything else is a real failure and should stop the run loudly.
          if (!(error instanceof UnsplashRateLimitError)) throw error;
          exhausted = true;
          break;
        }

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
      if (exhausted) break;
    }

    // A bucket interrupted halfway is thrown away rather than cached. Caching it
    // would make the next run skip it as done, leaving the place permanently
    // short of photographs to save the handful of requests already spent on it.
    if (exhausted) {
      out(
        `  ${query.padEnd(34)} interrupted — the hourly limit is spent.\n` +
          `    ${Object.keys(buckets).length} of ${counts.size} buckets cached; ` +
          "re-run in an hour to fetch the rest.",
      );
      break;
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

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

  const total = Object.values(buckets).reduce(
    (sum, bucket) => sum + bucket.landscape.length + bucket.portrait.length,
    0,
  );

  const missing = [...counts.keys()].filter((key) => !(key in buckets));

  out();
  out(`Wrote ${outPath}`);
  out(`  ${total} photographs across ${Object.keys(buckets).length} buckets`);

  if (missing.length > 0) {
    out(`  ${missing.length} bucket(s) still unfetched: ${missing.join(", ")}`);
    out("  Re-run once the hourly budget refreshes; the cache is merged into.");
  }

  if (remaining !== null) out(`  ${remaining} requests left this hour`);
  out("  Commit this file so the demo seeds without a key.");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
