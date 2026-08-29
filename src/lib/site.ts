/**
 * Facts about this deployment that the UI needs to state out loud.
 */

/**
 * Where the source lives.
 *
 * A placeholder until the repository has a home — set `NEXT_PUBLIC_GITHUB_URL`
 * to the real one and the footer follows.
 */
export const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL?.trim() || "https://github.com/roam-app/roam";

/** OpenStreetMap's attribution, required by the ODbL for data derived from it. */
export const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

export const SITE_NAME = "Roam";

export const SITE_TAGLINE =
  "Roam reads the coordinates buried in your holiday photographs and turns them back into the journey you took — the places you stopped, how long you stayed, and what you pointed the camera at.";
