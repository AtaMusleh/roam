/**
 * Shared domain types for Roam.
 *
 * These mirror `prisma/schema.prisma` but are declared independently of the
 * generated Prisma client, so tools that never touch the database — the
 * synthetic trip generator, the clustering code, unit tests — can import them
 * without a `prisma generate` having run first.
 *
 * Two shapes of the same data live here on purpose:
 *
 *  - `Trip` / `Place` / `Visit` / `Photo` are the in-app records, with `Date`s.
 *  - `Generated*` are the JSON-serialisable records the generator writes, with
 *    ISO-8601 strings, since JSON has no date type.
 */

import type { LatLng } from "../lib/geo";

export type { LatLng };

/** Mirrors the `GpsSource` enum in the Prisma schema. */
export const GPS_SOURCES = ["EXIF", "INTERPOLATED", "MANUAL", "NONE"] as const;

export type GpsSource = (typeof GPS_SOURCES)[number];

/** An ISO-8601 timestamp, e.g. `2026-05-14T09:12:00.000Z`. */
export type IsoDateTime = string;

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export interface Trip {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  coverPhotoId: string | null;
  slug: string;
  isPublic: boolean;
  createdAt: Date;
}

export interface Place {
  id: string;
  tripId: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  photoCount: number;
  createdAt: Date;
}

export interface Visit {
  id: string;
  placeId: string;
  arrivedAt: Date;
  departedAt: Date;
  sequence: number;
}

export interface Photo {
  id: string;
  tripId: string;
  visitId: string | null;
  cloudinaryId: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
  gpsSource: GpsSource;
  createdAt: Date;
}

/** A place with its visits resolved — the shape the map and timeline consume. */
export interface PlaceWithVisits extends Place {
  visits: Visit[];
}

/** A visit with its photos resolved. */
export interface VisitWithPhotos extends Visit {
  photos: Photo[];
}

// ---------------------------------------------------------------------------
// Synthetic trip generator
// ---------------------------------------------------------------------------

/** A real-world place the generator scatters photos around. */
export interface PlaceSpec {
  /** Stable key used by `VisitSpec` to refer back to this place. */
  key: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  /**
   * Standard deviation of the Gaussian GPS noise applied to photos taken here,
   * in metres. Larger for sprawling sites (a hill, a piazza), smaller for a
   * single room. Defaults to `DEFAULT_SIGMA_METERS`.
   */
  sigmaMeters?: number;
}

/** One bounded stay at a `PlaceSpec`. A place may appear in several of these. */
export interface VisitSpec {
  placeKey: string;
  /** Day offset from the trip's start date, 0-based. */
  day: number;
  /** Local arrival time as `HH:MM`, 24-hour. */
  arriveAt: string;
  durationMinutes: number;
  /** How many photos were taken during this stay. */
  photoCount: number;
}

export interface TripSpec {
  name: string;
  slug: string;
  /** Local calendar date the trip starts, as `YYYY-MM-DD`. */
  startDate: string;
  /** IANA-style UTC offset in hours, applied to `startDate` and `arriveAt`. */
  utcOffsetHours: number;
  places: PlaceSpec[];
  visits: VisitSpec[];
  /** Points far from any place — a day trip, a photo taken on the way home. */
  outliers: OutlierSpec[];
}

export interface OutlierSpec {
  name: string;
  lat: number;
  lng: number;
  /** Day offset from the trip's start date, 0-based. */
  day: number;
  /** Local capture time as `HH:MM`, 24-hour. */
  takenAt: string;
}

/** How a generated photo came to be — the label clustering has to recover. */
export type PhotoOrigin =
  /** Taken during a stay at a place. */
  | "place"
  /** Taken in transit between two consecutive visits. */
  | "transit"
  /** Taken far from any cluster. */
  | "outlier";

/** A photo as written to JSON: same fields as `Photo`, dates as ISO strings. */
export interface GeneratedPhoto {
  id: string;
  tripId: string;
  visitId: null;
  cloudinaryId: string;
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  takenAt: IsoDateTime | null;
  lat: number | null;
  lng: number | null;
  gpsSource: GpsSource;
}

export interface GeneratedPlace {
  id: string;
  key: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  sigmaMeters: number;
}

export interface GeneratedVisit {
  id: string;
  placeId: string;
  arrivedAt: IsoDateTime;
  departedAt: IsoDateTime;
  sequence: number;
}

/**
 * The answer key for one photo: where it was really taken, regardless of
 * whether its GPS survived into the dataset.
 */
export interface PhotoAssignment {
  photoId: string;
  origin: PhotoOrigin;
  /** The place this photo belongs to, or `null` for transit and outlier shots. */
  placeId: string | null;
  visitId: string | null;
  /** True when the generator stripped this photo's coordinates. */
  gpsStripped: boolean;
  /** Distance from the place centre before stripping, in metres. */
  trueDistanceMeters: number | null;
}

export interface GeneratedGroundTruth {
  places: GeneratedPlace[];
  visits: GeneratedVisit[];
  assignments: PhotoAssignment[];
}

export interface GeneratedTripMeta {
  generatedAt: IsoDateTime;
  seed: number;
  defaultSigmaMeters: number;
  gpsStripRate: number;
  photoCount: number;
  placeCount: number;
  visitCount: number;
  photosByOrigin: Record<PhotoOrigin, number>;
  photosWithoutGps: number;
}

/** The complete artefact `scripts/generate-trip.ts` writes. */
export interface GeneratedTripDataset {
  meta: GeneratedTripMeta;
  trip: {
    id: string;
    name: string;
    slug: string;
    startDate: IsoDateTime;
    endDate: IsoDateTime;
  };
  photos: GeneratedPhoto[];
  groundTruth: GeneratedGroundTruth;
}
