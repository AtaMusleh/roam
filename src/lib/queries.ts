/**
 * Server-side reads for the trip view.
 *
 * These shape the database rows into exactly what the page renders, and no
 * more. That matters here beyond the usual: everything returned crosses the
 * server/client boundary to reach the map and timeline, so an unselected column
 * is bytes on the wire for every visitor.
 */

import type { GpsSource } from "@/types";

import { tripDayKey } from "./format";
import { prisma } from "./prisma";

export interface TripPhoto {
  id: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  gpsSource: GpsSource;
}

export interface TripVisit {
  id: string;
  arrivedAt: Date;
  departedAt: Date;
  sequence: number;
  photos: TripPhoto[];
}

export interface TripPlace {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  visits: TripVisit[];
}

export interface TripDetail {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  isPublic: boolean;
  /** Minutes to add to a UTC instant for the traveller's wall clock. */
  utcOffsetMinutes: number;
  /** Chronological: the order the traveller first reached each place. */
  places: TripPlace[];
}

export interface TripStats {
  placeCount: number;
  photoCount: number;
  dayCount: number;
  visitCount: number;
}

/**
 * Loads a trip with everything the view needs, in display order throughout.
 *
 * Returns the trip whether or not it is public — the caller decides what to do
 * about that, which leaves room for an owner's private view later without a
 * second query.
 */
export async function getTripBySlug(slug: string): Promise<TripDetail | null> {
  const trip = await prisma.trip.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      startDate: true,
      endDate: true,
      isPublic: true,
      utcOffsetMinutes: true,
      places: {
        select: {
          id: true,
          name: true,
          address: true,
          lat: true,
          lng: true,
          visits: {
            orderBy: { arrivedAt: "asc" },
            select: {
              id: true,
              arrivedAt: true,
              departedAt: true,
              sequence: true,
              photos: {
                orderBy: { takenAt: "asc" },
                select: {
                  id: true,
                  url: true,
                  width: true,
                  height: true,
                  blurhash: true,
                  photographerName: true,
                  photographerUrl: true,
                  takenAt: true,
                  lat: true,
                  lng: true,
                  gpsSource: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!trip) return null;

  // Places come back in insertion order; the view wants them in the order the
  // traveller first arrived, which is what numbers the map markers and orders
  // the route line. Sorting here rather than in Prisma because ordering by a
  // minimum over a nested relation is not something the query language
  // expresses, and a dozen places sort for free.
  const places = [...trip.places].sort(
    (a, b) => firstArrival(a.visits) - firstArrival(b.visits),
  );

  return { ...trip, places };
}

/**
 * The span the trip was actually photographed over.
 *
 * Preferred to `Trip.startDate`/`endDate` for display. Those are stored as
 * absolute instants derived from a local calendar date, so rendering them back
 * in UTC can land a day early — the Rome demo starts at local midnight on 11
 * May, which is 22:00 on the 10th in UTC, and a header reading "10 May" for a
 * trip that began on the 11th is simply wrong. The first and last visits are
 * unambiguous by comparison, and they agree with the day count in
 * `getTripStats`, which is counted the same way.
 *
 * Returns null for a trip whose photos have not been clustered yet.
 */
export function photographedRange(
  places: readonly TripPlace[],
): { start: Date; end: Date } | null {
  let start: Date | null = null;
  let end: Date | null = null;

  for (const place of places) {
    for (const visit of place.visits) {
      if (start === null || visit.arrivedAt < start) start = visit.arrivedAt;
      if (end === null || visit.departedAt > end) end = visit.departedAt;
    }
  }

  return start === null || end === null ? null : { start, end };
}

function firstArrival(visits: readonly { arrivedAt: Date }[]): number {
  // A place with no visits has no position in the journey, and sorts last.
  return visits[0]?.arrivedAt.getTime() ?? Number.POSITIVE_INFINITY;
}

export interface ShowcasePhoto {
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
  placeName: string | null;
}

export interface Showcase {
  name: string;
  slug: string;
  stats: TripStats;
  /** A photograph from the trip, for the home page to lead with. */
  hero: ShowcasePhoto | null;
}

/**
 * The trip the home page advertises.
 *
 * The most recently created public one, which for now is the Rome demo. The
 * hero photograph is picked from what that trip actually contains rather than
 * being a separate asset — the point of the page is to show what the thing
 * produces, so the picture at the top should be one of its own.
 */
export async function getShowcase(): Promise<Showcase | null> {
  try {
    return await loadShowcase();
  } catch {
    // The home page is mostly prose and can stand without a trip to point at.
    // Failing the whole render because the database is unreachable — during a
    // build on a machine with no `DATABASE_URL`, say — would be a poor trade.
    return null;
  }
}

async function loadShowcase(): Promise<Showcase | null> {
  const trip = await prisma.trip.findFirst({
    where: { isPublic: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, slug: true, utcOffsetMinutes: true },
  });

  if (!trip) return null;

  const [stats, candidates] = await Promise.all([
    getTripStats(trip.id, trip.utcOffsetMinutes),
    prisma.photo.findMany({
      where: { tripId: trip.id, visitId: { not: null } },
      // Widest first, so the hero is a photograph that can carry a full-bleed
      // backdrop rather than one that has to be stretched to fill it.
      orderBy: [{ width: "desc" }, { id: "asc" }],
      take: 60,
      select: {
        url: true,
        width: true,
        height: true,
        blurhash: true,
        photographerName: true,
        photographerUrl: true,
        visit: { select: { place: { select: { name: true } } } },
      },
    }),
  ]);

  // Landscape only. A portrait photograph behind a full-width hero has to be
  // cropped so hard that whatever it was of is lost.
  const chosen =
    candidates.find((photo) => photo.width > photo.height * 1.3) ??
    candidates[0] ??
    null;

  return {
    name: trip.name,
    slug: trip.slug,
    stats,
    hero:
      chosen === null
        ? null
        : {
            url: chosen.url,
            width: chosen.width,
            height: chosen.height,
            blurhash: chosen.blurhash,
            photographerName: chosen.photographerName,
            photographerUrl: chosen.photographerUrl,
            placeName: chosen.visit?.place.name ?? null,
          },
  };
}

/**
 * Headline numbers for the trip.
 *
 * `dayCount` counts the distinct local calendar days the traveller was out
 * taking photographs, not the span between the first and last — a trip with a
 * rest day in the middle should not claim it. Counted in the trip's own time,
 * so a late night abroad does not become two days.
 */
export async function getTripStats(
  tripId: string,
  utcOffsetMinutes: number,
): Promise<TripStats> {
  const [placeCount, photoCount, visits] = await Promise.all([
    prisma.place.count({ where: { tripId } }),
    prisma.photo.count({ where: { tripId } }),
    prisma.visit.findMany({
      where: { place: { tripId } },
      select: { arrivedAt: true },
    }),
  ]);

  const days = new Set(
    visits.map((visit) => tripDayKey(visit.arrivedAt, utcOffsetMinutes)),
  );

  return {
    placeCount,
    photoCount,
    visitCount: visits.length,
    dayCount: days.size,
  };
}
