"use client";

import { useEffect } from "react";
import Lenis from "lenis";

import { REDUCED_MOTION_QUERY } from "@/lib/motion";

/**
 * Smooth scrolling, for the two pages that are just a long column.
 *
 * Mounted on the home page and `/trips` only. Not on a trip page: that screen
 * is a map beside its own scrolling timeline, and Lenis works by hijacking the
 * window's scroll and driving it from a rAF loop, which would fight the
 * timeline's own overflow container and the map's wheel-to-zoom.
 *
 * Renders nothing. It exists for its effect.
 */
export function SmoothScroll() {
  useEffect(() => {
    // Read once at mount rather than subscribed: someone changing the OS
    // setting mid-visit is vanishingly rare next to the cost of tearing the
    // scroll library down and rebuilding it while the page is being read.
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return;

    const lenis = new Lenis({
      // Just enough easing to take the edge off a wheel notch. Longer and the
      // page keeps moving after the reader has stopped asking it to, which
      // reads as lag rather than as smoothness.
      duration: 0.9,
      // Left alone on touch, where the platform's own scrolling is already
      // smooth and better than anything reimplemented on top of it.
      smoothWheel: true,
    });

    let frame = 0;

    const raf = (time: number): void => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };

    frame = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frame);
      // Restores the scroll position handling and the styles Lenis set, so a
      // client navigation to the trip page leaves the window scrolling
      // normally again.
      lenis.destroy();
    };
  }, []);

  return null;
}
