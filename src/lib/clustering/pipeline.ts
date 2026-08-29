/**
 * The clustering pipeline: a camera roll in, a journey out.
 *
 *   photos
 *     -> DBSCAN over the ones that have GPS          (where were the stops?)
 *     -> interpolate the ones that don't             (where was everything else?)
 *     -> attach the recovered ones to those stops
 *     -> split each stop along the time axis         (how many separate stays?)
 *     -> centroid each stop, order the stays
 *
 * Deliberately ordered that way. Interpolation runs *after* clustering and
 * never feeds back into it: inferred positions are less trustworthy than
 * measured ones, and letting them vote on cluster shape would let a guess about
 * one photo shift the boundaries of a place. Clusters are decided by EXIF
 * alone; the recovered photos are then fitted to the result.
 *
 * Everything here is pure. Same photos and options in, same journey out, no
 * database, no clock, no randomness.
 */

import { centroid, haversineDistance } from "../geo";
import type { LatLng } from "../geo";
import type { GpsSource } from "../../types";
import { dbscan } from "./dbscan";
import type { DbscanCluster } from "./dbscan";
import {
  DEFAULT_MAX_INTERPOLATION_GAP_MINUTES,
  interpolatePositions,
} from "./interpolate";
import type { UnresolvedPhoto } from "./interpolate";
import { DEFAULT_VISIT_GAP_MINUTES, splitIntoVisits } from "./temporal";

export interface PipelinePhoto {
  id: string;
  takenAt: Date | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Default DBSCAN radius, in metres.
 *
 * Chosen from the sweep in `scripts/evaluate-clustering.ts` over the Rome
 * dataset, which measures a genuine conflict rather than a tuning plateau:
 *
 *  - **Below 50m** the wide-spread sites shed their outer photos to noise.
 *    Foro Romano (σ=60m) and Palatino (σ=55m) are hectares of ruins, not
 *    points, and at ε=40m their recall falls to 67% and 43%.
 *  - **At 60m and above** the Pantheon and Sant'Eustachio — 100m apart, a
 *    basilica and the café on the next piazza — merge into a single place.
 *
 * The two constraints do not overlap. ε must exceed the spread of the widest
 * place and fall short of the gap to the nearest neighbouring place, and on
 * this trip the widest spread is larger than the smallest gap. No global ε
 * satisfies both, so the choice is which error to prefer.
 *
 * 60m prefers the merge. Losing more than half of Palatino's photos to noise
 * leaves a place looking sparse and empty with no obvious cause, whereas two
 * places fused into one is visible at a glance and the traveller can split it
 * by hand. An error the user can see and fix beats one they cannot.
 *
 * A variable-density algorithm (OPTICS, HDBSCAN) picks a local ε per cluster
 * and would dissolve the conflict outright. That is the real fix if manual
 * splitting proves tiresome.
 */
export const DEFAULT_EPSILON_METERS = 60;

/**
 * Default DBSCAN core-point threshold, counting the point itself.
 *
 * 4 is the lowest value that keeps a couple of stray photos on a street corner
 * from becoming a "place". Raising it to 5 costs recall at the thinly
 * photographed stops without buying any extra separation.
 */
export const DEFAULT_MIN_POINTS = 4;

export interface PipelineOptions {
  /** DBSCAN neighbourhood radius, in metres. Defaults to 60m. */
  epsilonMeters?: number;
  /** DBSCAN core-point threshold, counting the point itself. Defaults to 4. */
  minPoints?: number;
  /** Gap that separates two visits to one place. Defaults to 90 minutes. */
  visitGapMinutes?: number;
  /** Widest anchor gap that still permits interpolation. Defaults to 2 hours. */
  maxInterpolationGapMinutes?: number;
}

export interface ClusteredPlace {
  id: string;
  /** Centroid of the place's EXIF-positioned photos. */
  lat: number;
  lng: number;
  photoCount: number;
  visitCount: number;
}

export interface ClusteredVisit {
  id: string;
  placeId: string;
  /** First photo of the stay. The real arrival was a little earlier. */
  arrivedAt: Date;
  /** Last photo of the stay. The real departure was a little later. */
  departedAt: Date;
  /** Position in the trip's chronological order, starting at 0. */
  sequence: number;
  photoIds: string[];
}

/** Where one input photo ended up. One of these exists for every photo in. */
export interface PhotoPlacement {
  photoId: string;
  placeId: string | null;
  visitId: string | null;
  /** Resolved position: measured, inferred, or null if neither was possible. */
  lat: number | null;
  lng: number | null;
  gpsSource: GpsSource;
}

export interface PipelineStats {
  photosIn: number;
  photosWithGps: number;
  photosInterpolated: number;
  photosWithoutPosition: number;
  /** Positioned photos that landed in no cluster. */
  photosUnclustered: number;
  placesDetected: number;
  visitsDetected: number;
}

export interface PipelineResult {
  places: ClusteredPlace[];
  /** Chronological across the whole trip, not grouped by place. */
  visits: ClusteredVisit[];
  placements: PhotoPlacement[];
  /** Positioned photos that belong to no place — the walking-between shots. */
  unclusteredPhotoIds: string[];
  /** Photos left without a position, with the reason for each. */
  unpositioned: UnresolvedPhoto[];
  stats: PipelineStats;
}

/** A photo carried through clustering with a position attached. */
interface LocatedPhoto extends LatLng {
  photo: PipelinePhoto;
  source: Extract<GpsSource, "EXIF" | "INTERPOLATED">;
}

function hasGps(
  photo: PipelinePhoto,
): photo is PipelinePhoto & { lat: number; lng: number } {
  return photo.lat !== null && photo.lng !== null;
}

/**
 * Finds the cluster whose nearest core point is closest to `point`, provided it
 * is within epsilon.
 *
 * This is DBSCAN's own border-point rule reused: a point belongs to a cluster
 * if it lies inside the neighbourhood of one of that cluster's core points.
 * Measuring to the *centroid* instead would be wrong for sprawling places — a
 * photo at the far end of the Forum is 150m from its centre but a few metres
 * from a dozen other Forum photos.
 */
function nearestClusterWithinEpsilon(
  point: LatLng,
  clusters: readonly DbscanCluster<LocatedPhoto>[],
  epsilonMeters: number,
): number | null {
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index] as DbscanCluster<LocatedPhoto>;

    for (const core of cluster.corePoints) {
      const distance = haversineDistance(point, core);
      if (distance <= epsilonMeters && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }

  return bestIndex;
}

export function runPipeline(
  photos: readonly PipelinePhoto[],
  options: PipelineOptions = {},
): PipelineResult {
  const {
    epsilonMeters = DEFAULT_EPSILON_METERS,
    minPoints = DEFAULT_MIN_POINTS,
    visitGapMinutes = DEFAULT_VISIT_GAP_MINUTES,
    maxInterpolationGapMinutes = DEFAULT_MAX_INTERPOLATION_GAP_MINUTES,
  } = options;

  // --- 1. cluster the photos that know where they were --------------------

  const located: LocatedPhoto[] = photos.filter(hasGps).map((photo) => ({
    photo,
    lat: photo.lat,
    lng: photo.lng,
    source: "EXIF",
  }));

  const { clusters, noise } = dbscan(located, { epsilonMeters, minPoints });

  // Members are seeded from the clustering and grown in step 3.
  const members: LocatedPhoto[][] = clusters.map((cluster) => [
    ...cluster.points,
  ]);

  // --- 2. infer positions for the photos that don't -----------------------

  const { positions, unresolved } = interpolatePositions(
    photos.map((photo) => ({
      id: photo.id,
      takenAt: photo.takenAt,
      lat: photo.lat,
      lng: photo.lng,
    })),
    { maxGapMinutes: maxInterpolationGapMinutes },
  );

  const photosById = new Map(photos.map((photo) => [photo.id, photo]));

  // --- 3. fit the recovered photos to the clusters ------------------------

  const unclustered: LocatedPhoto[] = noise.map((point) => point);

  for (const position of positions) {
    const photo = photosById.get(position.photoId);
    if (!photo) continue;

    const recovered: LocatedPhoto = {
      photo,
      lat: position.lat,
      lng: position.lng,
      source: "INTERPOLATED",
    };

    const clusterIndex = nearestClusterWithinEpsilon(
      recovered,
      clusters,
      epsilonMeters,
    );

    if (clusterIndex === null) {
      // Positioned, but not near any place — most likely taken in transit.
      unclustered.push(recovered);
      continue;
    }

    (members[clusterIndex] as LocatedPhoto[]).push(recovered);
  }

  // --- 4. split each place along the time axis ----------------------------

  interface DraftVisit {
    clusterIndex: number;
    arrivedAt: Date;
    departedAt: Date;
    points: LocatedPhoto[];
  }

  const draftVisits: DraftVisit[] = [];
  /** Cluster members with no timestamp: they belong to a place, no visit. */
  const undatedByCluster: LocatedPhoto[][] = clusters.map(() => []);

  members.forEach((clusterMembers, clusterIndex) => {
    const dated: LocatedPhoto[] = [];

    for (const member of clusterMembers) {
      if (member.photo.takenAt === null) {
        (undatedByCluster[clusterIndex] as LocatedPhoto[]).push(member);
      } else {
        dated.push(member);
      }
    }

    const segments = splitIntoVisits(
      dated,
      (member) => member.photo.takenAt as Date,
      { maxGapMinutes: visitGapMinutes },
    );

    for (const segment of segments) {
      draftVisits.push({
        clusterIndex,
        arrivedAt: segment.arrivedAt,
        departedAt: segment.departedAt,
        points: segment.points,
      });
    }
  });

  // --- 5. order the journey and name everything ---------------------------

  draftVisits.sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());

  // Places are numbered in the order the traveller first reached them, so
  // place-1 is where the trip started. A cluster whose photos are all undated
  // has no visits and sorts to the end.
  const firstVisitByCluster = new Map<number, number>();
  draftVisits.forEach((visit) => {
    if (!firstVisitByCluster.has(visit.clusterIndex)) {
      firstVisitByCluster.set(visit.clusterIndex, visit.arrivedAt.getTime());
    }
  });

  const clusterOrder = clusters
    .map((_, index) => index)
    .sort((a, b) => {
      const aFirst = firstVisitByCluster.get(a) ?? Number.POSITIVE_INFINITY;
      const bFirst = firstVisitByCluster.get(b) ?? Number.POSITIVE_INFINITY;
      return aFirst === bFirst ? a - b : aFirst - bFirst;
    });

  const placeIdByCluster = new Map<number, string>();
  clusterOrder.forEach((clusterIndex, position) => {
    placeIdByCluster.set(clusterIndex, `place-${position + 1}`);
  });

  const placements: PhotoPlacement[] = [];

  const visits: ClusteredVisit[] = draftVisits.map((draft, index) => {
    const visitId = `visit-${index + 1}`;
    const placeId = placeIdByCluster.get(draft.clusterIndex) as string;

    for (const member of draft.points) {
      placements.push({
        photoId: member.photo.id,
        placeId,
        visitId,
        lat: member.lat,
        lng: member.lng,
        gpsSource: member.source,
      });
    }

    return {
      id: visitId,
      placeId,
      arrivedAt: draft.arrivedAt,
      departedAt: draft.departedAt,
      sequence: index,
      photoIds: draft.points.map((member) => member.photo.id),
    };
  });

  // Cluster members that had no timestamp: placed, but in no particular visit.
  undatedByCluster.forEach((undated, clusterIndex) => {
    for (const member of undated) {
      placements.push({
        photoId: member.photo.id,
        placeId: placeIdByCluster.get(clusterIndex) as string,
        visitId: null,
        lat: member.lat,
        lng: member.lng,
        gpsSource: member.source,
      });
    }
  });

  for (const member of unclustered) {
    placements.push({
      photoId: member.photo.id,
      placeId: null,
      visitId: null,
      lat: member.lat,
      lng: member.lng,
      gpsSource: member.source,
    });
  }

  for (const photo of unresolved) {
    placements.push({
      photoId: photo.photoId,
      placeId: null,
      visitId: null,
      lat: null,
      lng: null,
      gpsSource: "NONE",
    });
  }

  const places: ClusteredPlace[] = clusterOrder.map((clusterIndex) => {
    const cluster = clusters[clusterIndex] as DbscanCluster<LocatedPhoto>;

    // Centroid from measured positions only. Interpolated points sit on the
    // line between their anchors, which pulls a centroid toward the route the
    // traveller walked in rather than the place itself.
    const centre = centroid(cluster.points) ?? {
      lat: cluster.points[0]?.lat ?? 0,
      lng: cluster.points[0]?.lng ?? 0,
    };

    return {
      id: placeIdByCluster.get(clusterIndex) as string,
      lat: centre.lat,
      lng: centre.lng,
      photoCount: (members[clusterIndex] as LocatedPhoto[]).length,
      visitCount: draftVisits.filter((v) => v.clusterIndex === clusterIndex)
        .length,
    };
  });

  return {
    places,
    visits,
    placements,
    unclusteredPhotoIds: unclustered.map((member) => member.photo.id),
    unpositioned: unresolved,
    stats: {
      photosIn: photos.length,
      photosWithGps: located.length,
      photosInterpolated: positions.length,
      photosWithoutPosition: unresolved.length,
      photosUnclustered: unclustered.length,
      placesDetected: places.length,
      visitsDetected: visits.length,
    },
  };
}
