"use client";

import { decode } from "blurhash";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** Resolution the blurhash is decoded at. It is about to be blurred anyway. */
const BLURHASH_SIZE = 32;

interface BlurhashCanvasProps {
  hash: string;
  className?: string;
}

/**
 * The blurred stand-in shown while a photograph loads.
 *
 * A blurhash is around thirty characters that decode to a handful of pixels,
 * so the placeholder arrives with the page rather than as another request. It
 * is drawn at 32x32 and stretched by the browser, which is where the blur
 * comes from — no filter needed.
 *
 * Shared by the grid and the lightbox so a photograph is preceded by the same
 * colours wherever it appears.
 */
export function BlurhashCanvas({ hash, className }: BlurhashCanvasProps) {
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
      className={cn("absolute inset-0 h-full w-full", className)}
    />
  );
}
