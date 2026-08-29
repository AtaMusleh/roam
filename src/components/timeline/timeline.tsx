"use client";

import Image from "next/image";

import { formatTripDay, formatTripTime, pluralise } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { TimelineDay, TimelineEntry } from "./types";

interface TimelineProps {
  days: readonly TimelineDay[];
  selectedPlaceId: string | null;
  hoveredPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onHoverPlace: (placeId: string | null) => void;
}

/** How many thumbnails a timeline entry shows before it stops. */
const THUMBNAIL_LIMIT = 5;

function EntryRow({
  entry,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  entry: TimelineEntry;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
}) {
  const thumbnails = entry.photos.slice(0, THUMBNAIL_LIMIT);
  const remaining = entry.photoCount - thumbnails.length;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        onMouseEnter={() => {
          onHover(true);
        }}
        onMouseLeave={() => {
          onHover(false);
        }}
        onFocus={() => {
          onHover(true);
        }}
        onBlur={() => {
          onHover(false);
        }}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full cursor-pointer rounded-lg border border-transparent px-3 py-3 text-left",
          "transition-colors duration-150 outline-none",
          "hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-roam-accent/60",
          selected && "border-roam-accent/40 bg-muted/60",
          !selected && hovered && "bg-muted/40",
        )}
      >
        <div className="flex items-baseline gap-3">
          <time
            dateTime={entry.arrivedAt.toISOString()}
            className="font-mono text-xs tabular-nums text-muted-foreground"
          >
            {formatTripTime(entry.arrivedAt)}
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

        {thumbnails.length > 0 && (
          <div className="mt-2 flex gap-1">
            {thumbnails.map((photo) => (
              <div
                key={photo.id}
                className="relative h-12 w-12 shrink-0 overflow-hidden rounded bg-muted"
              >
                <Image
                  src={photo.url}
                  alt=""
                  fill
                  sizes="48px"
                  className="object-cover"
                />
              </div>
            ))}

            {remaining > 0 && (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-[11px] text-muted-foreground tabular-nums">
                +{remaining}
              </div>
            )}
          </div>
        )}
      </button>
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
  selectedPlaceId,
  hoveredPlaceId,
  onSelectPlace,
  onHoverPlace,
}: TimelineProps) {
  if (days.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing on this trip has been placed on the map yet.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border">
      {days.map((day, index) => (
        <section key={day.key} className="px-3 py-4">
          <header className="mb-2 flex items-baseline justify-between px-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {formatTripDay(day.date)}
            </h2>
            <span className="text-[11px] text-muted-foreground">
              Day {index + 1} &middot; {pluralise(day.photoCount, "photo")}
            </span>
          </header>

          <ol className="space-y-1">
            {day.entries.map((entry) => (
              <EntryRow
                key={entry.visitId}
                entry={entry}
                selected={entry.placeId === selectedPlaceId}
                hovered={entry.placeId === hoveredPlaceId}
                onSelect={() => {
                  onSelectPlace(entry.placeId);
                }}
                onHover={(hovering) => {
                  onHoverPlace(hovering ? entry.placeId : null);
                }}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
