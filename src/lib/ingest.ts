/**
 * Turning a trip's photos into places and visits, in the database.
 *
 * This is the seam between the pure clustering code and Postgres. The pipeline
 * knows nothing about persistence; this module runs it, gives the resulting
 * clusters names, and writes the outcome.
 *
 * Ingest is **idempotent**. Running it again on the same trip replaces that
 * trip's clustering rather than adding a second copy: the old places (and,
 * through the cascade, their visits) are deleted and rebuilt. That is what
 * makes re-clustering with different parameters a safe thing to offer from a
 * button in the UI.
 */

import type { Place, Prisma, Visit } from "@prisma/client";

import { runPipeline } from "./clustering/pipeline";
import type { PipelinePhoto, PipelineStats } from "./clustering/pipeline";
import { formatCoordinates, reverseGeocode } from "./geocode";
import { prisma } from "./prisma";

export interface IngestPhoto extends PipelinePhoto {
  id: string;
}

export interface IngestOptions {
  /**
   * Photos to cluster. Read from the trip's own photos when omitted, which is
   * the usual case — passing them explicitly is for callers that already hold
   * them, or for tests.
   */
  photos?: readonly IngestPhoto[];

  /** DBSCAN radius in metres. Defaults to the pipeline's 60m. */
  epsilonMeters?: number;
  /** DBSCAN core-point threshold. Defaults to the pipeline's 4. */
  minPoints?: number;
  /** Gap that separates two visits to one place. Defaults to 90 minutes. */
  visitGapMinutes?: number;
  /** Widest anchor gap that still permits interpolation. Defaults to 2 hours. */
  maxInterpolationGapMinutes?: number;

  /**
   * Whether to name places at all. Set false to skip the network entirely and
   * name every place by its coordinates — useful offline, in tests, and when
   * re-clustering repeatedly during parameter tuning.
   */
  geocode?: boolean;

  /**
   * Ignore cached names and look every place up again. For testing changes to
   * the naming rules; ordinary runs should leave this alone and read the cache.
   */
  forceGeocode?: boolean;
}

export interface IngestResult {
  tripId: string;
  places: Place[];
  visits: Visit[];
  stats: PipelineStats & {
    /** Photos attached to a visit. */
    photosAssigned: number;
    /** Photos left with `visitId: null` — noise, and anything unpositioned. */
    photosUnassigned: number;
    /** Place names that came from the geocoder rather than the fallback. */
    placesNamed: number;
  };
}

/** Interactive transactions default to 5 seconds, which is tight for ~30 writes. */
const TRANSACTION_TIMEOUT_MS = 30_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;

export async function ingestTrip(
  tripId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) {
    throw new Error(`No trip with id ${tripId}`);
  }

  // --- 1. gather the photos ------------------------------------------------

  const photos: IngestPhoto[] =
    options.photos !== undefined
      ? [...options.photos]
      : (
          await prisma.photo.findMany({
            where: { tripId },
            select: { id: true, takenAt: true, lat: true, lng: true },
            orderBy: { takenAt: "asc" },
          })
        ).map((photo) => ({
          id: photo.id,
          takenAt: photo.takenAt,
          lat: photo.lat,
          lng: photo.lng,
        }));

  // --- 2. cluster (pure, no I/O) -------------------------------------------

  const result = runPipeline(photos, {
    epsilonMeters: options.epsilonMeters,
    minPoints: options.minPoints,
    visitGapMinutes: options.visitGapMinutes,
    maxInterpolationGapMinutes: options.maxInterpolationGapMinutes,
  });

  // --- 3. name the places --------------------------------------------------
  //
  // Deliberately before the transaction opens, never inside it. Naming is
  // rate-limited to protect two free services, and takes several seconds per
  // place on a cold cache — a landmark lookup, then up to two reverse lookups.
  // Holding a database transaction open across that would pin a connection and
  // risk a statement timeout, to no purpose: nothing has been written yet, so
  // there is nothing to roll back.

  const shouldGeocode = options.geocode ?? true;
  let placesNamed = 0;

  const named = await Promise.all(
    result.places.map(async (place) => {
      if (!shouldGeocode) {
        return { place, name: formatCoordinates(place), address: null };
      }

      const geocoded = await reverseGeocode(place, {
        force: options.forceGeocode,
      });
      if (geocoded.source !== "fallback") placesNamed += 1;

      return { place, name: geocoded.name, address: geocoded.address };
    }),
  );

  // --- 4. write it, all or nothing -----------------------------------------

  const written = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // Detach every photo first. Deleting the places would cascade to visits
      // and null these anyway, but doing it explicitly means a photo that was
      // assigned last time and is noise this time is definitely reset.
      await tx.photo.updateMany({
        where: { tripId },
        data: { visitId: null },
      });

      // Cascades to Visit, which is why the visits are not deleted separately.
      await tx.place.deleteMany({ where: { tripId } });

      const placeIdByCluster = new Map<string, string>();

      for (const entry of named) {
        const created = await tx.place.create({
          data: {
            tripId,
            name: entry.name,
            address: entry.address,
            lat: entry.place.lat,
            lng: entry.place.lng,
            photoCount: entry.place.photoCount,
          },
        });
        placeIdByCluster.set(entry.place.id, created.id);
      }

      const createdVisits: Visit[] = [];

      for (const visit of result.visits) {
        const placeId = placeIdByCluster.get(visit.placeId);
        if (placeId === undefined) continue;

        const created = await tx.visit.create({
          data: {
            placeId,
            arrivedAt: visit.arrivedAt,
            departedAt: visit.departedAt,
            sequence: visit.sequence,
          },
        });
        createdVisits.push(created);

        if (visit.photoIds.length > 0) {
          await tx.photo.updateMany({
            where: { id: { in: visit.photoIds }, tripId },
            data: { visitId: created.id },
          });
        }
      }

      // Photos that clustered as noise keep `visitId: null` from the reset
      // above. They stay attached to the trip and remain fully retrievable —
      // "this photo belongs to no place" is an answer, not a lost record.

      const places = await tx.place.findMany({
        where: { tripId },
        orderBy: { createdAt: "asc" },
      });

      return { places, visits: createdVisits };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  const photosAssigned = result.visits.reduce(
    (total, visit) => total + visit.photoIds.length,
    0,
  );

  return {
    tripId,
    places: written.places,
    visits: written.visits,
    stats: {
      ...result.stats,
      photosAssigned,
      photosUnassigned: photos.length - photosAssigned,
      placesNamed,
    },
  };
}
