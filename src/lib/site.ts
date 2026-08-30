/**
 * Facts about this deployment that the UI needs to state out loud.
 */

/**
 * Where the source lives.
 *
 * Overridable with `NEXT_PUBLIC_GITHUB_URL`, so a fork's footer can point at
 * the fork rather than back here.
 */
export const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL?.trim() || "https://github.com/AtaMusleh/roam";

/** OpenStreetMap's attribution, required by the ODbL for data derived from it. */
export const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

export const SITE_NAME = "Roam";

/**
 * The trip the home page offers as a direct way in, alongside the index.
 *
 * Rome is the one every part of this was built against, so it is the one worth
 * pointing a first-time reader at. Named here rather than in the page so a
 * deployment with a different set of trips can change it in one place; if the
 * slug is absent, the home page falls back to the most recent trip.
 */
export const FEATURED_TRIP_SLUG =
  process.env.NEXT_PUBLIC_FEATURED_TRIP?.trim() || "rome-may-2026";

export const SITE_TAGLINE =
  "Roam reads the coordinates buried in your holiday photographs and turns them back into the journey you took — the places you stopped, how long you stayed, and what you pointed the camera at.";
