/**
 * The trip, rearranged for the timeline.
 *
 * `getTripBySlug` returns places each holding their visits, which is the right
 * shape for a map — one marker per place. A timeline needs the opposite: visits
 * in one chronological run, each knowing which place it belongs to, grouped by
 * day. `buildTimeline` in `./build` does that turn.
 */

import type { PhotoGridItem } from "@/components/photo-grid";

export interface TimelineEntry {
  visitId: string;
  placeId: string;
  placeName: string;
  arrivedAt: Date;
  departedAt: Date;
  photoCount: number;
  photos: PhotoGridItem[];
}

export interface TimelineDay {
  /** `2026-05-11`. Sortable, and stable as a React key. */
  key: string;
  /** The first arrival of the day, for formatting the heading. */
  date: Date;
  photoCount: number;
  entries: TimelineEntry[];
}
