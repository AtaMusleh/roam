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
import { FEATURED_TRIP_SLUG } from "./site";

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
  /** How many public trips there are — what the index promises. */
  tripCount: number;
  /** Summed across every public trip, for the headline numbers. */
  totals: TripStats;
  /** One trip to offer directly, as a shortcut past the index. */
  featured: { name: string; slug: string } | null;
  /** A photograph from the featured trip, for the home page to lead with. */
  hero: ShowcasePhoto | null;
}

/**
 * What the home page advertises: the whole collection, plus one way in.
 *
 * The counts are totals across every public trip, because the page now leads
 * to an index rather than to a single journey and quoting one trip's numbers
 * under a link to all of them would be a lie. The hero photograph still comes
 * from the featured trip's own photographs rather than being a separate asset
 * — the point of the page is to show what the thing produces.
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
  const trips = await prisma.trip.findMany({
    where: { isPublic: true },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: { id: true, name: true, slug: true, utcOffsetMinutes: true },
  });

  if (trips.length === 0) return null;

  // The named trip when it exists, and the most recent otherwise — a
  // deployment that never seeded Rome should still get a working link.
  const featured =
    trips.find((trip) => trip.slug === FEATURED_TRIP_SLUG) ?? trips[0];

  if (featured === undefined) return null;

  const [perTrip, candidates] = await Promise.all([
    Promise.all(
      trips.map((trip) => getTripStats(trip.id, trip.utcOffsetMinutes)),
    ),
    prisma.photo.findMany({
      where: { tripId: featured.id, visitId: { not: null } },
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

  // Days are summed rather than de-duplicated across trips: two journeys in
  // different months share no calendar days, and the number the page wants is
  // "days spent travelling", not "distinct dates in the database".
  const totals = perTrip.reduce<TripStats>(
    (sum, stats) => ({
      placeCount: sum.placeCount + stats.placeCount,
      photoCount: sum.photoCount + stats.photoCount,
      visitCount: sum.visitCount + stats.visitCount,
      dayCount: sum.dayCount + stats.dayCount,
    }),
    { placeCount: 0, photoCount: 0, visitCount: 0, dayCount: 0 },
  );

  // Landscape only. A portrait photograph behind a full-width hero has to be
  // cropped so hard that whatever it was of is lost.
  const chosen =
    candidates.find((photo) => photo.width > photo.height * 1.3) ??
    candidates[0] ??
    null;

  return {
    tripCount: trips.length,
    totals,
    featured: { name: featured.name, slug: featured.slug },
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

/** One card on the trips index. */
export interface TripSummary {
  id: string;
  name: string;
  slug: string;
  /**
   * The span actually photographed, falling back to the trip's stored dates
   * for a trip with no visits. Same reasoning as `photographedRange`: the
   * stored dates are local midnights held as UTC instants, and rendering one
   * back can land a day early.
   */
  start: Date;
  end: Date;
  utcOffsetMinutes: number;
  stats: TripStats;
  /** The photograph the card leads with, or null for an unclustered trip. */
  cover: ShowcasePhoto | null;
}

/**
 * Every public trip, newest first, with the numbers and cover a card needs.
 *
 * Ordered by `startDate` rather than `createdAt`: the index is a shelf of
 * journeys, and a reader scanning it is looking for when the traveller went,
 * not when the row was written. Seeding all four cities in one run would make
 * `createdAt` an accident of alphabetical order.
 *
 * Deliberately a fixed number of queries rather than one per trip: places,
 * photo counts and visits are each fetched once for the whole set and grouped
 * in memory. Only the covers cost a query apiece, and that is bounded by how
 * many trips exist.
 */
export async function getTripsIndex(): Promise<TripSummary[]> {
  const trips = await prisma.trip.findMany({
    where: { isPublic: true },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      startDate: true,
      endDate: true,
      utcOffsetMinutes: true,
    },
  });

  if (trips.length === 0) return [];

  const tripIds = trips.map((trip) => trip.id);

  const [places, photoCounts, visits] = await Promise.all([
    prisma.place.findMany({
      where: { tripId: { in: tripIds } },
      // Densest place first, so the head of each trip's group is the one whose
      // photographs the cover comes from.
      orderBy: [{ photoCount: "desc" }, { id: "asc" }],
      select: { id: true, tripId: true, name: true },
    }),
    prisma.photo.groupBy({
      by: ["tripId"],
      where: { tripId: { in: tripIds } },
      _count: { _all: true },
    }),
    prisma.visit.findMany({
      where: { place: { tripId: { in: tripIds } } },
      select: {
        arrivedAt: true,
        departedAt: true,
        place: { select: { tripId: true } },
      },
    }),
  ]);

  const placesByTrip = new Map<string, { id: string; name: string }[]>();
  for (const place of places) {
    const group = placesByTrip.get(place.tripId) ?? [];
    group.push({ id: place.id, name: place.name });
    placesByTrip.set(place.tripId, group);
  }

  const photosByTrip = new Map(
    photoCounts.map((row) => [row.tripId, row._count._all]),
  );

  const visitsByTrip = new Map<string, { arrivedAt: Date; departedAt: Date }[]>();
  for (const visit of visits) {
    const group = visitsByTrip.get(visit.place.tripId) ?? [];
    group.push({ arrivedAt: visit.arrivedAt, departedAt: visit.departedAt });
    visitsByTrip.set(visit.place.tripId, group);
  }

  return await Promise.all(
    trips.map(async (trip) => {
      const tripPlaces = placesByTrip.get(trip.id) ?? [];
      const tripVisits = visitsByTrip.get(trip.id) ?? [];

      const days = new Set(
        tripVisits.map((visit) =>
          tripDayKey(visit.arrivedAt, trip.utcOffsetMinutes),
        ),
      );

      const arrivals = tripVisits.map((visit) => visit.arrivedAt.getTime());
      const departures = tripVisits.map((visit) => visit.departedAt.getTime());

      return {
        id: trip.id,
        name: trip.name,
        slug: trip.slug,
        start:
          arrivals.length > 0 ? new Date(Math.min(...arrivals)) : trip.startDate,
        end:
          departures.length > 0 ? new Date(Math.max(...departures)) : trip.endDate,
        utcOffsetMinutes: trip.utcOffsetMinutes,
        stats: {
          placeCount: tripPlaces.length,
          photoCount: photosByTrip.get(trip.id) ?? 0,
          visitCount: tripVisits.length,
          dayCount: days.size,
        },
        cover: await coverPhoto(tripPlaces[0] ?? null),
      };
    }),
  );
}

/**
 * The widest landscape photograph belonging to a place.
 *
 * Widest because a card's cover is a letterbox and a narrow original has to be
 * upscaled to fill it; landscape because a portrait photograph in that box is
 * cropped to a vertical slice of itself. The check is done in JavaScript over
 * the widest few rather than in SQL, because the comparison is between two
 * columns of the same row and the candidate set is tiny either way.
 */
async function coverPhoto(
  place: { id: string; name: string } | null,
): Promise<ShowcasePhoto | null> {
  if (place === null) return null;

  const candidates = await prisma.photo.findMany({
    where: { visit: { placeId: place.id } },
    orderBy: [{ width: "desc" }, { id: "asc" }],
    take: 24,
    select: {
      url: true,
      width: true,
      height: true,
      blurhash: true,
      photographerName: true,
      photographerUrl: true,
    },
  });

  const chosen =
    candidates.find((photo) => photo.width > photo.height * 1.3) ??
    candidates[0] ??
    null;

  return chosen === null ? null : { ...chosen, placeName: place.name };
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
