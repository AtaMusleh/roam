"use client";

import Image from "next/image";
import { useState } from "react";

import { BlurhashCanvas } from "@/components/blurhash-canvas";
import { UNSPLASH_HOME } from "@/lib/unsplash";
import { cn } from "@/lib/utils";

export interface PhotoGridItem {
  id: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  /** Set for stock imagery, which must be credited wherever it is shown. */
  photographerName: string | null;
  photographerUrl: string | null;
}

/** Milliseconds each grid position adds to its photograph's fade. */
const STAGGER_STEP_MS = 30;

/** Position past which no further delay is added. */
const STAGGER_CAP = 12;

/**
 * The credit links become clickable exactly when the caption is visible.
 *
 * They have to opt back in to pointer events, because the caption around them
 * has opted out — and they must opt in only while shown, or an invisible link
 * would intercept clicks meant for the photograph beneath it.
 */
const CREDIT_LINK = cn(
  "pointer-events-none underline underline-offset-2 hover:text-white",
  "group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
  "[@media(hover:none)]:pointer-events-auto",
);

interface PhotoGridProps {
  photos: readonly PhotoGridItem[];
  /** Passed to `next/image`; the grid does not know its own column widths. */
  sizes?: string;
  className?: string;
  /**
   * Called when a photograph is clicked. Omit to leave the grid display-only.
   * The element is passed back so focus can return to it afterwards.
   */
  onOpen?: (photoId: string, origin: HTMLElement) => void;
}

function GridPhoto({
  photo,
  sizes,
  onOpen,
  index,
}: {
  photo: PhotoGridItem;
  sizes: string;
  onOpen?: (photoId: string, origin: HTMLElement) => void;
  /** Position in the grid, which sets how long its fade waits. */
  index: number;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <figure className="mb-2 break-inside-avoid">
      {/*
        The aspect-ratio box is the point of storing width and height on every
        photo: the space each image will occupy is reserved before the bytes
        arrive, so a column of thumbnails does not shuffle as they land.
      */}
      <div
        className="group relative overflow-hidden rounded-md bg-muted"
        style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
      >
        {photo.blurhash !== null && <BlurhashCanvas hash={photo.blurhash} />}

        {onOpen !== undefined && (
          /*
            The button sits above the image rather than wrapping it, so the
            figure keeps its aspect-ratio box and the credit below stays a
            sibling — a link inside a button is not something to hand a
            screen reader.
          */
          <button
            type="button"
            onClick={(event) => {
              onOpen(photo.id, event.currentTarget);
            }}
            aria-label={
              photo.photographerName === null
                ? "Open photo"
                : `Open photo by ${photo.photographerName}`
            }
            className="absolute inset-0 z-10 cursor-zoom-in focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:outline-none"
          />
        )}

        <Image
          src={photo.url}
          alt={photo.photographerName === null ? "" : `Photograph by ${photo.photographerName}`}
          fill
          sizes={sizes}
          onLoad={() => {
            setLoaded(true);
          }}
          // Staggered by position, so a wall of thumbnails arrives as a sweep
          // rather than all at once. Capped, because past a dozen the delay
          // stops reading as rhythm and starts reading as the page being slow —
          // and a place with fifty photographs would otherwise hold the last of
          // them back by a second and a half.
          style={{
            transitionDelay: `${String(Math.min(index, STAGGER_CAP) * STAGGER_STEP_MS)}ms`,
          }}
          className={cn(
            "object-cover transition-opacity duration-[240ms] ease-out",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />

        {photo.photographerName !== null && (
          /*
            Unsplash's API terms require the photographer and Unsplash to be
            credited with links wherever the photograph appears. On a wall of
            images a permanent caption would bury the photographs, so it
            surfaces on hover — and stays visible on touch devices, which have
            no hover to surface it with, and whenever a link inside is focused,
            so it is reachable by keyboard.
          */
          <figcaption
            className={cn(
              // Painted above the click target that opens the lightbox, but
              // transparent to the pointer. An `opacity-0` element still
              // catches clicks, and this one covers the bottom third of every
              // thumbnail — left interactive, it silently swallows every click
              // aimed at that part of the photograph.
              "pointer-events-none absolute inset-x-0 bottom-0 z-20",
              "bg-gradient-to-t from-black/80 to-transparent",
              "px-2 pb-1.5 pt-6 text-[10px] leading-tight text-white/90",
              "opacity-0 transition-opacity duration-200",
              "group-hover:opacity-100 group-focus-within:opacity-100",
              "[@media(hover:none)]:opacity-100",
            )}
          >
            Photo by{" "}
            <a
              href={photo.photographerUrl ?? UNSPLASH_HOME}
              target="_blank"
              rel="noreferrer noopener"
              className={CREDIT_LINK}
            >
              {photo.photographerName}
            </a>{" "}
            on{" "}
            <a href={UNSPLASH_HOME} target="_blank" rel="noreferrer noopener" className={CREDIT_LINK}>
              Unsplash
            </a>
          </figcaption>
        )}
      </div>
    </figure>
  );
}

/**
 * A masonry grid of photographs.
 *
 * CSS columns rather than a grid: photographs are all different shapes, and
 * columns let each keep its own without cropping to a common ratio or leaving
 * gaps. The cost is that reading order runs down each column rather than
 * across, which for a wall of holiday photographs is no cost at all.
 */
export function PhotoGrid({
  photos,
  sizes = "(min-width: 1024px) 20vw, (min-width: 640px) 30vw, 45vw",
  className,
  onOpen,
}: PhotoGridProps) {
  if (photos.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        No photographs here.
      </p>
    );
  }

  return (
    <div className={cn("columns-2 gap-2 sm:columns-3", className)}>
      {photos.map((photo, index) => (
        <GridPhoto
          key={photo.id}
          photo={photo}
          sizes={sizes}
          onOpen={onOpen}
          index={index}
        />
      ))}
    </div>
  );
}
