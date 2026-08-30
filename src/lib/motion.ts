/**
 * Shared timings for everything that moves.
 *
 * Kept in one place so the whole app agrees on how fast things are, and so the
 * brief's constraint — enter between 150 and 300ms, exits instant — is stated
 * once as numbers rather than repeated as a habit across a dozen files.
 *
 * ## Why exits are instant
 *
 * An entrance is the interface arriving; a reader is not waiting on it, because
 * they were not looking at the thing before it appeared. An exit is different:
 * it happens because someone asked for it to go, and every millisecond of it is
 * a millisecond they asked for something and did not get it. So entrances ease
 * and exits do not exist.
 *
 * ## Reduced motion
 *
 * `prefers-reduced-motion: reduce` means every animated thing renders in its
 * final state on the first frame — not a faster animation, not a fade instead
 * of a slide. Nothing here is load-bearing for comprehension, so removing all
 * of it costs the reader nothing, and the route line simply appears complete.
 */

/** Enter durations, in seconds, for Motion's API. */
export const DURATION = {
  /** Small things: a marker easing to its selected size, a card lifting. */
  fast: 0.15,
  /** The default for content arriving: a card, a section, a heading line. */
  base: 0.24,
  /** The longest an entrance is allowed to take. */
  slow: 0.3,
} as const;

/** Gap between staggered siblings. Short enough to read as one gesture. */
export const STAGGER = {
  tight: 0.04,
  base: 0.06,
  loose: 0.09,
} as const;

/**
 * The easing everything enters on.
 *
 * A standard "decelerate" curve: quick to start, settling at the end. Written
 * as a cubic-bézier tuple because Motion and CSS both take it, so the two
 * cannot drift.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** How far something rises as it fades in, in pixels. */
export const RISE_PX = 16;

/**
 * How much of an element must be on screen before it counts as entered.
 *
 * A margin rather than a ratio, so a tall section starts as its top edge
 * reaches the lower part of the viewport instead of waiting for a fifth of a
 * screen-height block to be visible.
 */
export const IN_VIEW_MARGIN = "0px 0px -12% 0px";

/** How long the trip page's route takes to draw itself, in milliseconds. */
export const ROUTE_DRAW_MS = 1500;

/** The media query that turns all of the above off. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
