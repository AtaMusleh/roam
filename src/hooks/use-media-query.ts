"use client";

import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query from JavaScript.
 *
 * Reach for a Tailwind breakpoint class first — this is for the cases where
 * the two layouts are different *components* rather than the same one styled
 * differently, and rendering both would do harm rather than waste.
 *
 * Returns `false` until the first effect runs, because the server has no
 * viewport to measure. Only use it for things that are hidden on first paint
 * anyway; anything visible immediately would flash the wrong layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const list = window.matchMedia(query);

    const update = (): void => {
      setMatches(list.matches);
    };

    update();
    list.addEventListener("change", update);

    return () => {
      list.removeEventListener("change", update);
    };
  }, [query]);

  return matches;
}

/** Matches Tailwind's `lg` breakpoint. */
export const DESKTOP_QUERY = "(min-width: 1024px)";
