"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

import { Reveal } from "@/components/motion/reveal";
import { useLightbox } from "@/components/photo-lightbox";
import { formatTripDay, formatTripTime, pluralise } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { TimelineDay, TimelineEntry } from "./types";

interface TimelineProps {
  days: readonly TimelineDay[];
  utcOffsetMinutes: number;
  selectedPlaceId: string | null;
  hoveredPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onHoverPlace: (placeId: string | null) => void;
}

/** How many thumbnails a timeline entry shows before it stops. */
const THUMBNAIL_LIMIT = 5;

function EntryRow({
  entry,
  utcOffsetMinutes,
  selected,
  hovered,
  onSelect,
  onHover,
  onOpenPhoto,
  registerRef,
}: {
  entry: TimelineEntry;
  utcOffsetMinutes: number;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onOpenPhoto: (index: number, origin: HTMLElement) => void;
  registerRef: (element: HTMLLIElement | null) => void;
}) {
  const thumbnails = entry.photos.slice(0, THUMBNAIL_LIMIT);
  const remaining = entry.photoCount - thumbnails.length;

  // The row and the thumbnails are separate controls, not one wrapping the
  // other: a button inside a button is invalid, and a screen reader given one
  // announces something incoherent. The wrapper carries the hover state so the
  // whole row still highlights as one thing.
  return (
    <li
      ref={registerRef}
      data-place-id={entry.placeId}
      onMouseEnter={() => {
        onHover(true);
      }}
      onMouseLeave={() => {
        onHover(false);
      }}
      className={cn(
        "rounded-lg border border-transparent px-3 py-3",
        "transition-colors duration-150",
        selected && "border-roam-accent/40 bg-muted/60",
        !selected && hovered && "bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onFocus={() => {
          onHover(true);
        }}
        onBlur={() => {
          onHover(false);
        }}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full cursor-pointer rounded text-left outline-none",
          "focus-visible:ring-2 focus-visible:ring-roam-accent/60",
        )}
      >
        <div className="flex items-baseline gap-3">
          <time
            dateTime={entry.arrivedAt.toISOString()}
            className="font-mono text-xs tabular-nums text-muted-foreground"
          >
            {formatTripTime(entry.arrivedAt, utcOffsetMinutes)}
          </time>

          <span
            className={cn(
              "flex-1 truncate text-sm font-medium",
              selected ? "text-roam-accent" : "text-foreground",
            )}
          >
            {entry.placeName}
          </span>

          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {entry.photoCount}
          </span>
        </div>
      </button>

      {thumbnails.length > 0 && (
        <div className="mt-2 flex gap-1">
          {thumbnails.map((photo, position) => (
            <button
              key={photo.id}
              type="button"
              onClick={(event) => {
                onOpenPhoto(position, event.currentTarget);
              }}
              aria-label={`Open photo ${position + 1} of ${entry.photoCount} from ${entry.placeName}`}
              className={cn(
                "relative h-12 w-12 shrink-0 cursor-zoom-in overflow-hidden rounded bg-muted",
                "outline-none focus-visible:ring-2 focus-visible:ring-roam-accent",
              )}
            >
              <Image
                src={photo.url}
                alt=""
                fill
                sizes="48px"
                className="object-cover"
              />
            </button>
          ))}

          {remaining > 0 && (
            // Opens the first photograph beyond the strip, so the overflow
            // count is a way in rather than a dead end.
            <button
              type="button"
              onClick={(event) => {
                onOpenPhoto(THUMBNAIL_LIMIT, event.currentTarget);
              }}
              aria-label={`Open the remaining ${remaining} photos from ${entry.placeName}`}
              className={cn(
                "flex h-12 w-12 shrink-0 cursor-zoom-in items-center justify-center rounded bg-muted",
                "text-[11px] text-muted-foreground tabular-nums",
                "outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-roam-accent",
              )}
            >
              +{remaining}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The trip as a list, in the order it happened.
 *
 * Grouped by day because that is how people remember a trip — "the morning we
 * went to the Forum" — and because the gaps between days are the structure. The
 * map answers where; this answers when, and the two share a selection so that
 * pointing at either points at both.
 */
export function Timeline({
  days,
  utcOffsetMinutes,
  selectedPlaceId,
  hoveredPlaceId,
  onSelectPlace,
  onHoverPlace,
}: TimelineProps) {
  /** The first row for each place, so a selection can be scrolled to. */
  const rowsRef = useRef(new Map<string, HTMLLIElement>());
  const openLightbox = useLightbox();

  // Selecting a place on the map has to bring its entry into view, or the
  // highlight lands somewhere the reader cannot see — on a five-day trip most
  // of the timeline is scrolled off. `block: "nearest"` means a row that is
  // already visible does not move, so clicking a row here never yanks the list
  // out from under the pointer.
  useEffect(() => {
    if (selectedPlaceId === null) return;

    const row = rowsRef.current.get(selectedPlaceId);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedPlaceId]);

  if (days.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing on this trip has been placed on the map yet.
      </p>
    );
  }

  // A place visited twice has two rows; the first is the one to scroll to.
  const claimed = new Set<string>();

  return (
    <div className="divide-y divide-border">
      {days.map((day, index) => (
        // Each day fades in as it is scrolled to, once. The observer watches
        // the viewport rather than this column, which is right: the column is
        // on screen, and a day's section crossing into view is the same event
        // either way.
        <Reveal as="section" key={day.key} className="px-3 py-4">
          <header className="mb-2 flex items-baseline justify-between px-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {formatTripDay(day.date, utcOffsetMinutes)}
            </h2>
            <span className="text-[11px] text-muted-foreground">
              Day {index + 1} &middot; {pluralise(day.photoCount, "photo")}
            </span>
          </header>

          <ol className="space-y-1">
            {day.entries.map((entry) => {
              const isFirstRowForPlace = !claimed.has(entry.placeId);
              if (isFirstRowForPlace) claimed.add(entry.placeId);

              return (
                <EntryRow
                  key={entry.visitId}
                  entry={entry}
                  utcOffsetMinutes={utcOffsetMinutes}
                  selected={entry.placeId === selectedPlaceId}
                  hovered={entry.placeId === hoveredPlaceId}
                  onSelect={() => {
                    onSelectPlace(entry.placeId);
                  }}
                  onHover={(hovering) => {
                    onHoverPlace(hovering ? entry.placeId : null);
                  }}
                  onOpenPhoto={(index, origin) => {
                    openLightbox({
                      photos: entry.photos,
                      index,
                      origin,
                      label: entry.placeName,
                    });
                  }}
                  registerRef={(element) => {
                    if (!isFirstRowForPlace) return;

                    if (element) rowsRef.current.set(entry.placeId, element);
                    else rowsRef.current.delete(entry.placeId);
                  }}
                />
              );
            })}
          </ol>
        </Reveal>
      ))}
    </div>
  );
}
