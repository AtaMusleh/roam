import type { TripPlace } from "@/lib/queries";
import { tripDayKey } from "@/lib/format";

import type { TimelineDay, TimelineEntry } from "./types";

/**
 * Turns places-with-visits into days-with-entries.
 *
 * Pure and synchronous, so it runs once on the server as part of rendering the
 * page rather than in every client that loads it.
 */
export function buildTimeline(
  places: readonly TripPlace[],
  utcOffsetMinutes: number,
): TimelineDay[] {
  const entries: TimelineEntry[] = [];

  for (const place of places) {
    for (const visit of place.visits) {
      entries.push({
        visitId: visit.id,
        placeId: place.id,
        placeName: place.name,
        arrivedAt: visit.arrivedAt,
        departedAt: visit.departedAt,
        photoCount: visit.photos.length,
        photos: visit.photos.map((photo) => ({
          id: photo.id,
          url: photo.url,
          width: photo.width,
          height: photo.height,
          blurhash: photo.blurhash,
          photographerName: photo.photographerName,
          photographerUrl: photo.photographerUrl,
        })),
      });
    }
  }

  entries.sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());

  const days = new Map<string, TimelineDay>();

  for (const entry of entries) {
    const key = tripDayKey(entry.arrivedAt, utcOffsetMinutes);
    const day = days.get(key);

    if (day) {
      day.entries.push(entry);
      day.photoCount += entry.photoCount;
    } else {
      days.set(key, {
        key,
        date: entry.arrivedAt,
        photoCount: entry.photoCount,
        entries: [entry],
      });
    }
  }

  // Insertion order already follows the sorted entries, but sorting the keys
  // says so explicitly rather than relying on it.
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key));
}
