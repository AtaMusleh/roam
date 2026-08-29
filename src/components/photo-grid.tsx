"use client";

import { decode } from "blurhash";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface PhotoGridItem {
  id: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
}

interface PhotoGridProps {
  photos: readonly PhotoGridItem[];
  /** Passed to `next/image`; the grid does not know its own column widths. */
  sizes?: string;
  className?: string;
}

/** Resolution the blurhash is decoded at. It is about to be blurred anyway. */
const BLURHASH_SIZE = 32;

/**
 * The blurred stand-in shown while a photograph loads.
 *
 * A blurhash is around thirty characters that decode to a handful of pixels,
 * so the placeholder arrives with the page rather than as another request. It
 * is drawn at 32x32 and stretched by the browser, which is where the blur
 * comes from — no filter needed.
 */
function BlurhashCanvas({ hash }: { hash: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let pixels: Uint8ClampedArray;
    try {
      pixels = decode(hash, BLURHASH_SIZE, BLURHASH_SIZE);
    } catch {
      // A malformed hash is not worth failing a photograph over; the muted
      // background behind this canvas is a perfectly good placeholder.
      return;
    }

    const image = context.createImageData(BLURHASH_SIZE, BLURHASH_SIZE);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
  }, [hash]);

  return (
    <canvas
      ref={canvasRef}
      width={BLURHASH_SIZE}
      height={BLURHASH_SIZE}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}

function GridPhoto({ photo, sizes }: { photo: PhotoGridItem; sizes: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <figure className="mb-2 break-inside-avoid">
      {/*
        The aspect-ratio box is the point of storing width and height on every
        photo: the space each image will occupy is reserved before the bytes
        arrive, so a column of thumbnails does not shuffle as they land.
      */}
      <div
        className="relative overflow-hidden rounded-md bg-muted"
        style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
      >
        {photo.blurhash !== null && <BlurhashCanvas hash={photo.blurhash} />}

        <Image
          src={photo.url}
          alt=""
          fill
          sizes={sizes}
          onLoad={() => {
            setLoaded(true);
          }}
          className={cn(
            "object-cover transition-opacity duration-500",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
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
      {photos.map((photo) => (
        <GridPhoto key={photo.id} photo={photo} sizes={sizes} />
      ))}
    </div>
  );
}
