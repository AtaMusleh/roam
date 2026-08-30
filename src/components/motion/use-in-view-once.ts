"use client";

import { useEffect, useState } from "react";

/**
 * Whether an element has ever been on screen.
 *
 * ## Why not Motion's `useInView`
 *
 * That one takes a `RefObject` and sets its observer up in an effect keyed on
 * the ref *object*, which never changes. That is fine when the observed
 * element is the same node for the component's whole life, and wrong here.
 *
 * These components swap a plain `<ul>` for a `motion.ul` the moment they arm,
 * and to React those are different element types — a host element and a
 * component — so it unmounts one and mounts the other rather than reusing the
 * node. The observer was left watching a node that had been removed from the
 * document, which cannot intersect anything, so the cards sat at `opacity: 0`
 * for ever, waiting to enter a viewport they were already in.
 *
 * A callback ref reports every node change, so the observer follows the
 * element that is actually on the page. It also makes this independent of when
 * Motion happens to attach its refs, which is a detail no caller should have to
 * reason about.
 *
 * Latches: once true it stops observing and never goes back. Everything using
 * it animates once and stays put.
 */
export function useInViewOnce(
  margin: string,
): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  // No IntersectionObserver — an old browser, or a test environment that stubs
  // it away. Nothing would ever be observed, so treat everything as visible
  // rather than hiding it for ever. Derived during render rather than set from
  // the effect, which would be a state update with nothing to react to.
  const unsupported = typeof IntersectionObserver === "undefined";

  useEffect(() => {
    if (node === null || seen || unsupported) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [margin, node, seen, unsupported]);

  return [setNode, seen || unsupported];
}
