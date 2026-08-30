/**
 * The committed photography cache for the demo trip.
 *
 * `scripts/fetch-unsplash.ts` writes it; `scripts/seed-demo-trip.ts` reads it.
 * Keeping the shape and the bucketing rules here means the two scripts cannot
 * disagree about what a bucket is called or which photographs belong in it.
 *
 * The file is committed on purpose. Unsplash needs a key and has an hourly
 * limit, and a demo that only works for whoever holds the key is not a demo.
 * With the cache in the repository, seeding is offline, deterministic, and
 * identical on every machine.
 */

import type { UnsplashPhoto } from "./unsplash";

export interface UnsplashCacheBucket {
  /**
   * The searches that produced these, in the order they were tried, kept so
   * the cache explains itself. More than one means the place's own name came
   * up short and a broader query filled in.
   */
  queries: string[];
  landscape: UnsplashPhoto[];
  portrait: UnsplashPhoto[];
}

export interface UnsplashCache {
  generatedAt: string;
  /** Keyed by the dataset's ground-truth place key, or `GENERAL_BUCKET`. */
  buckets: Record<string, UnsplashCacheBucket>;
}

/**
 * Bucket for photographs belonging to no place: the sparse shots taken walking
 * between stops, and the two day-trip outliers.
 */
export const GENERAL_BUCKET = "_general";

/**
 * A city slug as it should read in a search: `bunkers-del-carmel` is a place
 * key, `Barcelona` is what a photographer tagged their picture with.
 */
export function cityLabel(city: string): string {
  return city
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Search used for the general bucket. */
export function generalQuery(city: string): string {
  return `${cityLabel(city)} street`;
}

/**
 * Appends the city to a place's name to keep the search in the right one.
 *
 * "Foro Romano" alone is ambiguous enough to return a forum in Pompeii, and
 * "Gothic Quarter" without a city returns Gothic quarters everywhere. The
 * suffix has to be the *right* city: an early multi-city run left "Rome"
 * hard-coded here, and "Barri Gòtic Rome" returned nothing at all.
 */
export function bucketQuery(placeName: string, city: string): string {
  return `${placeName} ${cityLabel(city)}`;
}

/** Which orientation a photograph of these dimensions needs. */
export function orientationOf(
  width: number,
  height: number,
): "landscape" | "portrait" {
  // Square counts as landscape; there is no third orientation to search for.
  return height > width ? "portrait" : "landscape";
}

/**
 * Picks the photograph for the `index`-th shot of a given orientation.
 *
 * Cycles when a place has more photographs than Unsplash returned for it — the
 * Vatican Museums want fifty-eight and a search yields thirty. Repeating is
 * visibly better than a gap, and the alternative, spending more of an hourly
 * budget of fifty requests to page deeper, buys little.
 */
export function pickFromBucket(
  bucket: UnsplashCacheBucket | undefined,
  orientation: "landscape" | "portrait",
  index: number,
): UnsplashPhoto | null {
  if (!bucket) return null;

  // Fall back to the other orientation rather than returning nothing: a
  // correctly-credited photograph of the right place in the wrong shape beats
  // a placeholder.
  const preferred = bucket[orientation];
  const pool =
    preferred.length > 0
      ? preferred
      : bucket[orientation === "landscape" ? "portrait" : "landscape"];

  if (pool.length === 0) return null;

  return pool[index % pool.length] ?? null;
}
