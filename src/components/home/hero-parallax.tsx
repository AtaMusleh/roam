"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * How far the photograph travels relative to the page, as a fraction.
 *
 * 0.5 is "half speed": scrolling one hero-height moves the image half that, so
 * it lags behind the text on top of it. The element is made taller by the same
 * fraction to cover the travel, or a gap would open at its bottom edge.
 */
const PARALLAX_FACTOR = 0.5;

/**
 * Moves the hero photograph at half the page's speed as it scrolls away.
 *
 * GSAP rather than Motion for this one because ScrollTrigger's `scrub` ties the
 * tween's playhead directly to scroll position — the image is wherever the
 * scrollbar says it should be on every frame, including during a fling or a
 * jump to an anchor. Motion's scroll hooks drive a spring toward a target
 * instead, which is right for most things and wrong for a backdrop that has to
 * stay locked to the page.
 *
 * Wraps its children rather than taking a ref, so the page keeps rendering the
 * `next/image` it already had and this supplies only the movement.
 */
export function HeroParallax({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    const trigger = element?.parentElement;
    if (!element || !trigger) return;

    gsap.registerPlugin(ScrollTrigger);

    // `matchMedia` rather than an early return: it registers the animation
    // against a query, and `revert()` undoes every style it set. With reduced
    // motion set the tween is never created at all and the image sits exactly
    // where the stylesheet put it.
    const context = gsap.matchMedia();

    context.add("(prefers-reduced-motion: no-preference)", () => {
      // Travel in pixels, measured from the *trigger* rather than as a
      // percentage of the element.
      //
      // The trigger scrolls past over its own height, so moving the image down
      // by half that during the same span leaves it covering half the ground —
      // which is what "half speed" means. A `yPercent` would be a fraction of
      // the element instead, and the element is deliberately 150% of the
      // trigger's height, so `yPercent: 50` came out at a quarter speed rather
      // than a half.
      const span = trigger.offsetHeight;

      gsap.fromTo(
        element,
        { y: 0 },
        {
          y: span * PARALLAX_FACTOR,
          ease: "none",
          scrollTrigger: {
            trigger,
            start: "top top",
            end: "bottom top",
            // Tied to the scrollbar, with a touch of smoothing so a trackpad's
            // discrete steps do not read as jitter.
            scrub: 0.4,
            // Re-measured when the viewport changes, since `span` is a pixel
            // value taken from a `dvh`-sized element.
            invalidateOnRefresh: true,
          },
        },
      );
    });

    return () => {
      context.revert();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      // Taller than its container by exactly the distance it will travel.
      style={{ height: `${String((1 + PARALLAX_FACTOR) * 100)}%` }}
    >
      {children}
    </div>
  );
}
