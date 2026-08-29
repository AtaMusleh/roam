/**
 * Theme values needed outside CSS.
 *
 * Almost all colour lives in `globals.css` as custom properties, where Tailwind
 * can reach it. Mapbox is the exception: its paint properties are given to a
 * WebGL renderer that never sees the stylesheet, so a literal colour string has
 * to be handed over in JavaScript.
 *
 * Keep this in step with `--roam-accent` in `src/app/globals.css`.
 */
export const ROAM_ACCENT = "#f0a044";

/** Mapbox style used for the trip map. Dark, so photographs carry the page. */
export const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";
