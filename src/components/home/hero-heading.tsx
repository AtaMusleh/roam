"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import { DURATION, EASE_OUT, STAGGER } from "@/lib/motion";

import { useMotionArmed } from "@/components/motion/use-motion-armed";

/**
 * The home page heading, revealed a line at a time.
 *
 * ## Finding the lines
 *
 * "Line by line" is a problem because lines are not in the markup — they are
 * decided by the browser after layout, and they change with the viewport, the
 * font, and `text-balance`. Hard-coding line breaks would reveal the wrong
 * groups at every width but one.
 *
 * So the heading is rendered as individual words, and their line membership is
 * *measured*: words sharing an `offsetTop` are on the same line. Each word then
 * animates with the delay of the line it turned out to be on, so a line arrives
 * as one movement while the breaks stay wherever the browser put them. A resize
 * re-measures.
 *
 * Words are `inline-block` because a plain inline box cannot be transformed,
 * and are given the same whitespace as the text they replace — the spaces are
 * real text nodes between them rather than margins, so justification and
 * balancing behave exactly as they would without any of this.
 *
 * Unarmed — server-rendered, no JavaScript, or reduced motion — none of it
 * runs and the heading is plain text, laid out and painted once.
 */
export function HeroHeading({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const armed = useMotionArmed();

  /** Line index per word, or null before the first measurement. */
  const [lines, setLines] = useState<number[] | null>(null);

  const words = text.split(" ");

  useEffect(() => {
    if (!armed) return;

    const heading = ref.current;
    if (heading === null) return;

    const measure = (): void => {
      const spans = heading.querySelectorAll<HTMLElement>("[data-word]");

      let line = -1;
      let previousTop: number | null = null;
      const assigned: number[] = [];

      for (const span of spans) {
        // Rounded: sub-pixel differences within one line are common once a
        // font has been swapped in, and would otherwise split it in two.
        const top = Math.round(span.offsetTop);
        if (previousTop === null || top > previousTop + 2) {
          line += 1;
          previousTop = top;
        }
        assigned.push(Math.max(0, line));
      }

      setLines(assigned);
    };

    measure();

    // Re-measure on resize, and once more after fonts settle: a heading laid
    // out in the fallback face rebreaks when the real one arrives.
    const observer = new ResizeObserver(measure);
    observer.observe(heading);

    void document.fonts?.ready.then(measure);

    return () => {
      observer.disconnect();
    };
  }, [armed, text]);

  // The plain heading is what the server sends, what a reader without
  // JavaScript keeps, and what reduced motion leaves alone.
  if (!armed) {
    return <h1 className={className}>{text}</h1>;
  }

  return (
    <h1 ref={ref} className={className}>
      {/* The accessible name is the whole sentence, read once. Without this a
          screen reader announces a heading built of forty separate spans. */}
      <span className="sr-only">{text}</span>

      <span aria-hidden>
        {words.map((word, index) => (
          // Words repeat, so the index is the identity here. The space after
          // each is a real text node *outside* the transformed box: put inside
          // an inline-block it stops being a break opportunity and the heading
          // refuses to wrap.
          <span key={index}>
            <motion.span
              data-word
              className="inline-block"
              initial={{ opacity: 0, y: "0.4em" }}
              // Nothing moves until the lines are known, so a word never
              // animates on one line's timing and then turns out to be on
              // another.
              animate={
                lines === null ? { opacity: 0, y: "0.4em" } : { opacity: 1, y: 0 }
              }
              transition={{
                duration: DURATION.slow,
                ease: EASE_OUT,
                delay: (lines?.[index] ?? 0) * STAGGER.loose,
              }}
            >
              {word}
            </motion.span>
            {index < words.length - 1 ? " " : null}
          </span>
        ))}
      </span>
    </h1>
  );
}
