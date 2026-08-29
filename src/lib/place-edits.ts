/**
 * Manual corrections to what clustering decided.
 *
 * Clustering is a heuristic over a heuristic — density over coordinates that
 * are themselves accurate to a few metres — and it is wrong often enough to
 * matter. On the Rome demo, four of eleven places carry the name of something
 * standing inside them rather than the place itself, two neighbouring squares
 * merge into one at any radius wide enough to hold the Forum, and a café is
 * inseparable from the basilica ninety metres away.
 *
 * None of that has to be solved to ship, so long as it can be fixed by hand.
 * These four operations are that escape hatch: rename, merge, split, delete.
 * They are what makes an imperfect algorithm acceptable rather than a problem
 * to keep tuning.
 *
 * Every one of them ends by putting the trip back in a consistent state —
 * centroids and photo counts recomputed for whatever changed, and visit
 * sequences renumbered across the whole trip, since any of these can change
 * what order the journey runs in.
 */

import type { Prisma } from "@prisma/client";

import { centroid } from "./geo";
import { prisma } from "./prisma";

/**
 * Whether the deployment permits changes.
 *
 * The demo is public and read-only; editing is for running it locally against
 * your own trips. Off unless explicitly switched on, so forgetting to set it
 * fails closed.
 */
export function editsAllowed(): boolean {
  return process.env.ALLOW_EDITS === "true";
}

export class PlaceEditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlaceEditError";
  }
}

type Tx = Prisma.TransactionClient;

/**
 * Recomputes a place's centre and photo count from what it now contains.
 *
 * The centre is the spherical centroid of the photographs that carry a
 * measured position. Interpolated ones are deliberately left out: they sit on
 * a line between their neighbours in time, and letting them vote pulls the
 * centre toward the route the traveller walked in on rather than the place.
 *
 * A place left with no positioned photographs keeps the coordinates it had —
 * they are still the best guess available, and moving it to null-island would
 * be worse.
 */
async function recomputePlace(tx: Tx, placeId: string): Promise<void> {
  const photos = await tx.photo.findMany({
    where: { visit: { placeId } },
    select: { lat: true, lng: true, gpsSource: true },
  });

  const measured = photos.filter(
    (photo): photo is { lat: number; lng: number; gpsSource: "EXIF" } =>
      photo.gpsSource === "EXIF" && photo.lat !== null && photo.lng !== null,
  );

  const positioned = measured.length > 0
    ? measured
    : photos.filter(
        (photo): photo is typeof photo & { lat: number; lng: number } =>
          photo.lat !== null && photo.lng !== null,
      );

  const centre = centroid(positioned.map((photo) => ({ lat: photo.lat, lng: photo.lng })));

  await tx.place.update({
    where: { id: placeId },
    data: {
      photoCount: photos.length,
      ...(centre === null ? {} : { lat: centre.lat, lng: centre.lng }),
    },
  });
}

/**
 * Renumbers every visit on the trip into chronological order.
 *
 * `sequence` is what the map's route line and the marker numbers are drawn
 * from, so it has to be right across the whole trip after any edit, not just
 * for the place that changed — merging two places can reorder everything that
 * follows.
 */
async function resequenceVisits(tx: Tx, tripId: string): Promise<void> {
  const visits = await tx.visit.findMany({
    where: { place: { tripId } },
    orderBy: { arrivedAt: "asc" },
    select: { id: true, sequence: true },
  });

  await Promise.all(
    visits.map((visit, index) =>
      visit.sequence === index
        ? Promise.resolve(null)
        : tx.visit.update({ where: { id: visit.id }, data: { sequence: index } }),
    ),
  );
}

async function requirePlace(
  tx: Tx,
  placeId: string,
): Promise<{ id: string; tripId: string; name: string }> {
  const place = await tx.place.findUnique({
    where: { id: placeId },
    select: { id: true, tripId: true, name: true },
  });

  if (!place) throw new PlaceEditError("No place with that id", 404);
  return place;
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

export async function renamePlace(placeId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new PlaceEditError("A place needs a name", 400);
  }

  await prisma.$transaction(async (tx) => {
    await requirePlace(tx, placeId);
    await tx.place.update({ where: { id: placeId }, data: { name: trimmed } });
  });
}

/**
 * Folds one place into another, keeping both sets of visits.
 *
 * The visits are moved rather than merged: two mornings at the same café stay
 * two mornings. Only the place they belong to changes.
 */
export async function mergePlaces(
  placeId: string,
  otherPlaceId: string,
): Promise<void> {
  if (placeId === otherPlaceId) {
    throw new PlaceEditError("A place cannot be merged into itself", 400);
  }

  await prisma.$transaction(async (tx) => {
    const target = await requirePlace(tx, placeId);
    const source = await requirePlace(tx, otherPlaceId);

    if (target.tripId !== source.tripId) {
      throw new PlaceEditError("Places from different trips cannot be merged", 400);
    }

    await tx.visit.updateMany({
      where: { placeId: otherPlaceId },
      data: { placeId },
    });

    // Emptied of visits, so deleting it cascades to nothing.
    await tx.place.delete({ where: { id: otherPlaceId } });

    await recomputePlace(tx, placeId);
    await resequenceVisits(tx, target.tripId);
  });
}

/**
 * Cuts a place in two at a chosen visit.
 *
 * The dividing visit and everything after it chronologically move to a new
 * place; everything before stays. That is the shape the mistake usually takes
 * — a cluster wide enough to have swallowed the next square along, where the
 * traveller moved from one to the other at a particular moment.
 */
export async function splitPlace(
  placeId: string,
  dividingVisitId: string,
): Promise<{ newPlaceId: string }> {
  return prisma.$transaction(async (tx) => {
    const place = await requirePlace(tx, placeId);

    const visits = await tx.visit.findMany({
      where: { placeId },
      orderBy: { arrivedAt: "asc" },
      select: { id: true },
    });

    const at = visits.findIndex((visit) => visit.id === dividingVisitId);
    if (at === -1) {
      throw new PlaceEditError("That visit does not belong to this place", 400);
    }
    if (at === 0) {
      throw new PlaceEditError(
        "Splitting at the first visit would leave the original place empty",
        400,
      );
    }

    const moving = visits.slice(at).map((visit) => visit.id);

    const created = await tx.place.create({
      data: {
        tripId: place.tripId,
        // Named after its parent, since nothing better is known yet. Renaming
        // it is the obvious next thing to do, and is one dialog away.
        name: `${place.name} (2)`,
        lat: 0,
        lng: 0,
        photoCount: 0,
      },
      select: { id: true },
    });

    await tx.visit.updateMany({
      where: { id: { in: moving } },
      data: { placeId: created.id },
    });

    await recomputePlace(tx, placeId);
    await recomputePlace(tx, created.id);
    await resequenceVisits(tx, place.tripId);

    return { newPlaceId: created.id };
  });
}

/**
 * Removes a place, returning its photographs to the trip unassigned.
 *
 * Nothing is destroyed but the grouping. The cascade from `Place` to `Visit`
 * nulls each photograph's `visitId` rather than deleting it, which is the
 * whole reason that relation is `SET NULL` — a wrong place is a wrong answer
 * about photographs, not a reason to lose them.
 */
export async function deletePlace(placeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const place = await requirePlace(tx, placeId);

    await tx.place.delete({ where: { id: placeId } });
    await resequenceVisits(tx, place.tripId);
  });
}
