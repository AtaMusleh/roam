"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * Arming has to happen before the browser paints, or the reader sees the final
 * state for a frame and then watches it animate in from nothing — a flash of
 * the answer before the question. Only a layout effect is early enough, and
 * React warns about those during server rendering, where they never run.
 */
const useBeforePaint =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Whether this render should animate.
 *
 * ## Why this is not just `!useReducedMotion()`
 *
 * The server has no media queries, so it cannot know the preference. Branching
 * the markup directly on `useReducedMotion()` therefore renders one thing on
 * the server and, for anyone whose browser answers the query immediately, a
 * different thing on the client's very first render — a hydration mismatch,
 * which React reports as an error and recovers from by throwing the server's
 * HTML away and rebuilding the subtree.
 *
 * So the answer starts as "no" on both sides, and only becomes "yes" in a
 * layout effect, which runs on the client alone. The consequences fall the
 * right way round:
 *
 *  - The server renders every animated thing in its **final** state. That is
 *    also what a reader with JavaScript disabled gets, and what a crawler
 *    indexes — content, rather than a page of `opacity: 0`.
 *  - Someone with `prefers-reduced-motion: reduce` never arms, so that final
 *    state is simply what they keep. No motion, no flash, nothing to undo.
 *  - Everyone else arms before the first paint, so the animation's starting
 *    frame is the first thing drawn and nothing is seen twice.
 */
export function useMotionArmed(): boolean {
  const reduced = useReducedMotion();
  const [armed, setArmed] = useState(false);

  useBeforePaint(() => {
    // Explicitly `false`, not merely falsy: the hook returns `null` until it
    // has read the query, and "not yet known" is not permission to animate.
    if (reduced === false) setArmed(true);
  }, [reduced]);

  return armed;
}
