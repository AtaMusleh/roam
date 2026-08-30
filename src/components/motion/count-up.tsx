"use client";

import { useEffect, useState } from "react";

import { IN_VIEW_MARGIN } from "@/lib/motion";

import { useInViewOnce } from "./use-in-view-once";
import { useMotionArmed } from "./use-motion-armed";

interface CountUpProps {
  value: number;
  /** Milliseconds to run for. Slightly longer than a fade, to be readable. */
  durationMs?: number;
  className?: string;
}

/** Decelerating, so the number lands on its final value rather than slamming into it. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts from zero to `value` when it first scrolls into view.
 *
 * Rendered inside a `tabular-nums` context by its callers so the digits do not
 * jitter the layout as they change width.
 *
 * The final value is always written exactly, from `value` rather than from the
 * last interpolated frame — rounding a float at 0.999 of the way through is
 * how a counter ends on 1,617 instead of 1,618.
 *
 * Unarmed it renders the real number and never moves. That matters beyond the
 * preference: this is content, not decoration, and it has to be correct in the
 * server-rendered HTML for anyone who never runs the animation — a reader with
 * JavaScript off, or a crawler.
 */
export function CountUp({ value, durationMs = 900, className }: CountUpProps) {
  const armed = useMotionArmed();
  const [observe, inView] = useInViewOnce(IN_VIEW_MARGIN);

  /** What the animation has reached, or null before it has run a frame. */
  const [counted, setCounted] = useState<number | null>(null);

  // Derived rather than synchronised by an effect. `armed` flips before the
  // first paint, so this render is the first one drawn — which means an armed
  // counter starts at zero without the real number ever having been on screen,
  // and an unarmed one shows the real number and never moves.
  const shown = armed ? (counted ?? 0) : value;

  useEffect(() => {
    if (!armed || !inView) return;

    let frame = 0;
    const started = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / durationMs);

      if (t >= 1) {
        setCounted(value);
        return;
      }

      setCounted(Math.round(value * easeOut(t)));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [armed, durationMs, inView, value]);

  return (
    <span ref={observe} className={className}>
      {shown.toLocaleString("en-GB")}
    </span>
  );
}
