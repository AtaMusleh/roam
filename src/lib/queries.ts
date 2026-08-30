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
  // The same aggregate the index uses, and the same cache entry. This was
  // three queries per trip — twelve for four trips — for numbers the index had
  // already worked out.
  const trips = await getTripsIndex();

  if (trips.length === 0) return null;

  // The named trip when it exists, and the most recent otherwise — a
  // deployment that never seeded Rome should still get a working link.
  const featured =
    trips.find((trip) => trip.slug === FEATURED_TRIP_SLUG) ?? trips[0];

  if (featured === undefined) return null;

  const candidates = await prisma.photo.findMany({
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
  });

  // Days are summed rather than de-duplicated across trips: two journeys in
  // different months share no calendar days, and the number the page wants is
  // "days spent travelling", not "distinct dates in the database".
  const totals = trips.reduce<TripStats>(
    (sum, trip) => ({
      placeCount: sum.placeCount + trip.stats.placeCount,
      photoCount: sum.photoCount + trip.stats.photoCount,
      visitCount: sum.visitCount + trip.stats.visitCount,
      dayCount: sum.dayCount + trip.stats.dayCount,
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
 * How long the index survives untouched, in milliseconds.
 *
 * The data behind it changes on a reseed and on a manual correction. The
 * corrections clear it immediately; a reseed happens outside Next entirely and
 * cannot, so this is the ceiling on how long a reseeded trip can be missing
 * from the index.
 */
const TRIPS_INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * The index as it survives the cache boundary.
 *
 * Instants are carried as epoch milliseconds rather than `Date`s. Next's cache
 * round-trips its entries through serialisation, which turns a `Date` into a
 * string, and a `TripSummary.start` that is secretly a string would blow up in
 * `formatTripDateRange` at render time rather than here. Numbers survive
 * intact and are turned back into `Date`s at the one boundary below.
 */
interface CachedTripSummary extends Omit<TripSummary, "start" | "end"> {
  startMs: number;
  endMs: number;
}

/** One row of the aggregate below. */
interface TripAggregateRow {
  id: string;
  name: string;
  slug: string;
  utcOffsetMinutes: number;
  startMs: number;
  endMs: number;
  placeCount: number;
  visitCount: number;
  dayCount: number;
  photoCount: number;
}

/** One row of the cover query below. */
interface CoverRow {
  tripId: string;
  placeName: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string | null;
  photographerUrl: string | null;
}

/**
 * Every public trip with its counts, in one aggregate.
 *
 * Raw SQL rather than Prisma's query builder because what this needs — counts
 * over two levels of relation, a distinct count of *derived* local dates, and
 * a photo total that must not be inflated by the join fan-out — is a `GROUP
 * BY` with a scalar subquery, and expressing that through the client would
 * mean the several separate round trips this replaces.
 *
 * `COUNT(DISTINCT ...)` on places and visits because the `Place`→`Visit` join
 * multiplies rows; photographs are counted in a subquery for the same reason,
 * where joining them would multiply every other count by the photo count.
 *
 * The day count reproduces `tripDayKey` in SQL: shift the stored UTC instant
 * by the trip's own offset, then take the date. Both columns are `timestamp
 * without time zone` holding UTC, so the shift is plain interval arithmetic
 * and no session time zone is involved.
 *
 * `EXTRACT(EPOCH ...)` on a `timestamp without time zone` reads it as UTC,
 * which is what these hold. Cast to `float8` rather than `bigint` so it
 * arrives as a JavaScript number; epoch milliseconds are around 1.8e12, well
 * inside what a double represents exactly.
 */
function tripAggregate(): Promise<TripAggregateRow[]> {
  return prisma.$queryRaw<TripAggregateRow[]>`
    SELECT
      t.id,
      t.name,
      t.slug,
      t."utcOffsetMinutes" AS "utcOffsetMinutes",
      (EXTRACT(EPOCH FROM COALESCE(MIN(v."arrivedAt"), t."startDate")) * 1000)::float8
        AS "startMs",
      (EXTRACT(EPOCH FROM COALESCE(MAX(v."departedAt"), t."endDate")) * 1000)::float8
        AS "endMs",
      COUNT(DISTINCT p.id)::int AS "placeCount",
      COUNT(DISTINCT v.id)::int AS "visitCount",
      COUNT(DISTINCT (
        v."arrivedAt" + t."utcOffsetMinutes" * INTERVAL '1 minute'
      )::date)::int AS "dayCount",
      (SELECT COUNT(*)::int FROM "Photo" ph WHERE ph."tripId" = t.id)
        AS "photoCount"
    FROM "Trip" t
    LEFT JOIN "Place" p ON p."tripId" = t.id
    LEFT JOIN "Visit" v ON v."placeId" = p.id
    WHERE t."isPublic" = TRUE
    GROUP BY t.id, t.name, t.slug, t."utcOffsetMinutes", t."startDate", t."endDate"
    ORDER BY t."startDate" DESC, t.name ASC
  `;
}

/**
 * One cover photograph per public trip, in a single pass.
 *
 * Two window functions rather than a query per trip. The first ranks each
 * trip's places by how many photographs they hold and keeps the densest; the
 * second ranks that place's photographs, landscape first and then widest.
 *
 * Ordering by `(width > height * 1.3) DESC` puts landscape ahead of portrait
 * because Postgres sorts `TRUE` above `FALSE`. That reproduces what the old
 * per-trip lookup did — take the widest landscape, fall back to the widest of
 * anything — with one difference worth naming: the old version only looked at
 * the twenty-four widest photographs, so a place whose landscape shots were
 * all narrow fell back to a portrait. This considers every photograph in the
 * place, so it finds a landscape cover strictly more often.
 */
function coverCandidates(): Promise<CoverRow[]> {
  return prisma.$queryRaw<CoverRow[]>`
    WITH ranked_places AS (
      SELECT
        p.id,
        p."tripId",
        p.name,
        ROW_NUMBER() OVER (
          PARTITION BY p."tripId"
          ORDER BY p."photoCount" DESC, p.id ASC
        ) AS place_rank
      FROM "Place" p
      JOIN "Trip" t ON t.id = p."tripId"
      WHERE t."isPublic" = TRUE
    ),
    ranked_photos AS (
      SELECT
        rp."tripId" AS "tripId",
        rp.name AS "placeName",
        ph.url,
        ph.width,
        ph.height,
        ph.blurhash,
        ph."photographerName" AS "photographerName",
        ph."photographerUrl" AS "photographerUrl",
        ROW_NUMBER() OVER (
          PARTITION BY rp."tripId"
          ORDER BY
            (ph.width::float8 > ph.height::float8 * 1.3) DESC,
            ph.width DESC,
            ph.id ASC
        ) AS photo_rank
      FROM ranked_places rp
      JOIN "Visit" v ON v."placeId" = rp.id
      JOIN "Photo" ph ON ph."visitId" = v.id
      WHERE rp.place_rank = 1
    )
    SELECT
      "tripId",
      "placeName",
      url,
      width,
      height,
      blurhash,
      "photographerName",
      "photographerUrl"
    FROM ranked_photos
    WHERE photo_rank = 1
  `;
}

/**
 * Every public trip, newest first, with the numbers and cover a card needs.
 *
 * Ordered by `startDate` rather than `createdAt`: the index is a shelf of
 * journeys, and a reader scanning it is looking for when the traveller went,
 * not when the row was written. Seeding all four cities in one run would make
 * `createdAt` an accident of alphabetical order.
 *
 * Two queries, run concurrently, and then cached. It used to be eleven issued
 * one after another — a count per trip, a photo count per trip, a visit list,
 * and a cover lookup for each trip in turn — which on a cold serverless
 * invocation against a sleeping Neon instance was slow enough that the
 * client-side navigation gave up and showed its own error page.
 */
async function readTripsIndex(): Promise<CachedTripSummary[]> {
  const [trips, covers] = await Promise.all([
    tripAggregate(),
    coverCandidates(),
  ]);

  const coverByTrip = new Map(covers.map((cover) => [cover.tripId, cover]));

  return trips.map((trip) => {
    const cover = coverByTrip.get(trip.id);

    return {
      id: trip.id,
      name: trip.name,
      slug: trip.slug,
      startMs: trip.startMs,
      endMs: trip.endMs,
      utcOffsetMinutes: trip.utcOffsetMinutes,
      stats: {
        placeCount: trip.placeCount,
        photoCount: trip.photoCount,
        visitCount: trip.visitCount,
        dayCount: trip.dayCount,
      },
      cover:
        cover === undefined
          ? null
          : {
              url: cover.url,
              width: cover.width,
              height: cover.height,
              blurhash: cover.blurhash,
              photographerName: cover.photographerName,
              photographerUrl: cover.photographerUrl,
              placeName: cover.placeName,
            },
    };
  });
}

function withDates(rows: CachedTripSummary[]): TripSummary[] {
  return rows.map(({ startMs, endMs, ...trip }) => ({
    ...trip,
    start: new Date(startMs),
    end: new Date(endMs),
  }));
}

/**
 * The cache itself: one entry, in this module, with a timestamp.
 *
 * Deliberately not `unstable_cache`. That API is deprecated in Next 16, and it
 * throws outright when called without a request context — which makes it
 * unusable from a script or a test, and a hazard anywhere the context is not
 * guaranteed. A plain module-level value has neither problem: it is a variable,
 * it works identically wherever it is read from, and there is nothing about it
 * to reason about.
 *
 * The in-flight promise is held rather than only the result, so a burst of
 * concurrent requests arriving on a cold cache share one pair of queries
 * instead of each starting its own.
 *
 * Per-process, which is the honest limit. Several server instances each keep
 * their own copy, so a correction made against one is invisible to the others
 * until their five minutes are up. For an index of four demo trips that is the
 * right trade; anything that needed better would want a shared store, and the
 * shape here is the shape that would port to one.
 */
let tripsIndexCache: {
  readAt: number;
  rows: Promise<CachedTripSummary[]>;
} | null = null;

/**
 * Drops the cached index.
 *
 * Called after any edit that could change what the index shows — which is all
 * four place operations, since every one of them moves photographs between
 * places or removes a place outright.
 */
export function clearTripsIndexCache(): void {
  tripsIndexCache = null;
}

/** The cached index. Safe to call from anywhere, request context or not. */
export async function getTripsIndex(): Promise<TripSummary[]> {
  const now = Date.now();

  if (tripsIndexCache === null || now - tripsIndexCache.readAt >= TRIPS_INDEX_TTL_MS) {
    const rows = readTripsIndex();

    // Stored before it settles, so concurrent callers join this read. Cleared
    // again on failure, or a single hiccup would be cached as the answer for
    // the next five minutes.
    tripsIndexCache = { readAt: now, rows };
    rows.catch(() => {
      tripsIndexCache = null;
    });
  }

  return withDates(await tripsIndexCache.rows);
}

/**
 * The same index, always straight from the database.
 *
 * For scripts and tests, which want to check what is actually stored rather
 * than whatever this process last read.
 */
export async function fetchTripsIndex(): Promise<TripSummary[]> {
  return withDates(await readTripsIndex());
}

/** A trip reduced to what a `<select>` needs. */
export interface TripOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * Every trip, for choosing which one an import belongs to.
 *
 * Private trips are included: this is only ever rendered behind the owner
 * session, and the owner's own unpublished trip is exactly the sort of thing
 * they would be adding photographs to.
 */
export async function getTripOptions(): Promise<TripOption[]> {
  return prisma.trip.findMany({
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: { id: true, name: true, slug: true },
  });
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
