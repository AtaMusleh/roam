"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";

import {
  DURATION,
  EASE_OUT,
  IN_VIEW_MARGIN,
  RISE_PX,
  STAGGER,
} from "@/lib/motion";

import { useInViewOnce } from "./use-in-view-once";
import { useMotionArmed } from "./use-motion-armed";

interface RevealProps {
  children: ReactNode;
  /** Seconds to wait after entering, for hand-ordered sequences. */
  delay?: number;
  /** Distance to rise, in pixels. Zero for a plain fade. */
  rise?: number;
  className?: string;
  /** Rendered element. A list item needs to stay a list item. */
  as?: "div" | "li" | "section" | "article" | "p";
}

/**
 * Fades and rises its children once, as they enter the viewport.
 *
 * `once: true` throughout: an element that re-animates every time it is
 * scrolled past turns a page into a fairground, and re-reading a paragraph
 * should not make it flicker.
 *
 * Unarmed — on the server, without JavaScript, or under reduced motion — this
 * renders a plain element with no animation attached at all. See
 * `useMotionArmed` for why that is the default rather than the exception.
 */
export function Reveal({
  children,
  delay = 0,
  rise = RISE_PX,
  className,
  as = "div",
}: RevealProps) {
  const armed = useMotionArmed();
  const [observe, inView] = useInViewOnce(IN_VIEW_MARGIN);

  // The callback ref goes on in both branches, so the observer follows the
  // node across the swap from plain element to motion component.
  if (!armed) {
    const Plain = as;
    return (
      <Plain ref={observe} className={className}>
        {children}
      </Plain>
    );
  }

  const Component = motion[as];

  return (
    <Component
      ref={observe}
      className={className}
      initial={{ opacity: 0, y: rise }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: rise }}
      transition={{ duration: DURATION.base, ease: EASE_OUT, delay }}
    >
      {children}
    </Component>
  );
}

interface RevealGroupProps {
  children: ReactNode[];
  /** Seconds between siblings. */
  stagger?: number;
  /** Seconds before the first one. */
  delay?: number;
  rise?: number;
  className?: string;
  as?: "div" | "ul" | "ol";
  itemAs?: "div" | "li";
  /**
   * Classes for the wrappers: one string for all of them, or one per child.
   *
   * An array rather than an index function, because a Server Component cannot
   * pass a function across the boundary to a Client one — Next refuses it, and
   * the whole route 500s. Callers wanting per-item classes build the array.
   */
  itemClassName?: string | readonly (string | undefined)[];
}

/**
 * The same, for a set of siblings that should arrive one after another.
 *
 * The whole group shares one viewport observer rather than one each: the point
 * of a stagger is that the items are perceived as a sequence, which only works
 * if they are triggered by the group crossing the threshold rather than by
 * each item crossing it separately. Observed individually, a grid row would
 * fire simultaneously and the stagger would vanish.
 */
export function RevealGroup({
  children,
  stagger = STAGGER.base,
  delay = 0,
  rise = RISE_PX,
  className,
  as = "div",
  itemAs = "div",
  itemClassName,
}: RevealGroupProps) {
  const armed = useMotionArmed();
  const [observe, inView] = useInViewOnce(IN_VIEW_MARGIN);

  const classFor = (index: number): string | undefined =>
    itemClassName === undefined || typeof itemClassName === "string"
      ? itemClassName
      : itemClassName[index];

  if (!armed) {
    const Plain = as;
    const PlainItem = itemAs;

    return (
      <Plain ref={observe} className={className}>
        {children.map((child, index) => (
          <PlainItem key={index} className={classFor(index)}>
            {child}
          </PlainItem>
        ))}
      </Plain>
    );
  }

  const Container = motion[as];
  const Item = motion[itemAs];

  return (
    <Container ref={observe} className={className}>
      {children.map((child, index) => (
        <Item
          key={index}
          className={classFor(index)}
          initial={{ opacity: 0, y: rise }}
          animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: rise }}
          transition={{
            duration: DURATION.base,
            ease: EASE_OUT,
            delay: delay + index * stagger,
          }}
        >
          {child}
        </Item>
      ))}
    </Container>
  );
}
