/**
 * Recovering positions for photos that arrived without GPS.
 *
 * Roughly one photo in seven has no coordinates — location services off, a
 * screenshot, an image that passed through an app which stripped the EXIF. They
 * still have timestamps, and a timestamp is a strong positional hint: a photo
 * taken between two photos two minutes apart was taken between them in space
 * too, because nobody moves far in two minutes.
 *
 * That inference gets weaker the wider the surrounding gap, and at some point
 * it stops being an inference and starts being a guess. A photo with no GPS
 * whose nearest positioned neighbours are five hours apart could have been
 * taken anywhere in the city. So there is a hard limit: past
 * `maxGapMinutes`, the photo is left unpositioned. An honest gap in the map is
 * worth more than a plausible-looking pin in the wrong place.
 */

import { interpolate as interpolateAlongGreatCircle } from "../geo";
import type { LatLng } from "../geo";

export const DEFAULT_MAX_INTERPOLATION_GAP_MINUTES = 120;

export interface InterpolationOptions {
  /**
   * If the two positioned photos surrounding an unpositioned one are further
   * apart in time than this, no position is inferred. Defaults to
   * `DEFAULT_MAX_INTERPOLATION_GAP_MINUTES`.
   */
  maxGapMinutes?: number;
}

export interface InterpolationInput {
  id: string;
  takenAt: Date | null;
  /** Null on both axes together when the photo has no position. */
  lat: number | null;
  lng: number | null;
}

export interface InterpolatedPosition {
  photoId: string;
  lat: number;
  lng: number;
  /** The positioned photo immediately before this one in time. */
  beforePhotoId: string;
  /** The positioned photo immediately after this one in time. */
  afterPhotoId: string;
  /** How far apart in time the two anchors were. Smaller is more trustworthy. */
  anchorGapMinutes: number;
}

/** Why a photo was left without a position. */
export type UnresolvedReason =
  /** No timestamp, so there is nothing to interpolate against. */
  | "no-timestamp"
  /** Nothing positioned before it — it opens the roll. */
  | "no-anchor-before"
  /** Nothing positioned after it — it closes the roll. */
  | "no-anchor-after"
  /** The anchors straddle too much time to infer anything from. */
  | "gap-too-large";

export interface UnresolvedPhoto {
  photoId: string;
  reason: UnresolvedReason;
  /** The anchor gap that was rejected, when the reason is `gap-too-large`. */
  anchorGapMinutes: number | null;
}

export interface InterpolationResult {
  positions: InterpolatedPosition[];
  unresolved: UnresolvedPhoto[];
}

const MINUTE_MS = 60_000;

function hasPosition(
  photo: InterpolationInput,
): photo is InterpolationInput & LatLng {
  return photo.lat !== null && photo.lng !== null;
}

/**
 * Infers positions for the photos that lack them, from the ones that have them.
 *
 * Anchors are the nearest positioned photos *in time*, before and after — not
 * the nearest in the input order, which is why the whole roll is sorted first.
 * The inferred point sits along the great circle between the two anchors, at
 * the fraction of the way that the timestamp sits between theirs. That assumes
 * constant-speed travel in a straight line between the anchors, which is a lie
 * over long gaps and very nearly true over short ones — hence the cutoff.
 *
 * Interpolated photos are never used as anchors for other interpolated photos:
 * the anchors are always real EXIF positions, so errors cannot compound down a
 * chain of consecutive GPS-less photos.
 */
export function interpolatePositions(
  photos: readonly InterpolationInput[],
  options: InterpolationOptions = {},
): InterpolationResult {
  const maxGapMinutes =
    options.maxGapMinutes ?? DEFAULT_MAX_INTERPOLATION_GAP_MINUTES;

  if (!(maxGapMinutes > 0)) {
    throw new Error(`maxGapMinutes must be positive, got ${maxGapMinutes}`);
  }

  const maxGapMs = maxGapMinutes * MINUTE_MS;

  const positions: InterpolatedPosition[] = [];
  const unresolved: UnresolvedPhoto[] = [];

  const timed: InterpolationInput[] = [];

  for (const photo of photos) {
    if (photo.takenAt === null) {
      // Nothing to place it between. A photo with neither GPS nor a timestamp
      // carries no locational information at all.
      if (!hasPosition(photo)) {
        unresolved.push({
          photoId: photo.id,
          reason: "no-timestamp",
          anchorGapMinutes: null,
        });
      }
      continue;
    }

    timed.push(photo);
  }

  timed.sort(
    (a, b) =>
      (a.takenAt as Date).getTime() - (b.takenAt as Date).getTime(),
  );

  // Two linear sweeps record, for every photo, the index of the nearest
  // positioned photo on each side. Doing it up front keeps the whole pass
  // linear instead of re-scanning outward from each gap.
  const previousAnchor = new Array<number>(timed.length).fill(-1);
  const nextAnchor = new Array<number>(timed.length).fill(-1);

  let seen = -1;
  for (let index = 0; index < timed.length; index += 1) {
    previousAnchor[index] = seen;
    if (hasPosition(timed[index] as InterpolationInput)) seen = index;
  }

  seen = -1;
  for (let index = timed.length - 1; index >= 0; index -= 1) {
    nextAnchor[index] = seen;
    if (hasPosition(timed[index] as InterpolationInput)) seen = index;
  }

  for (let index = 0; index < timed.length; index += 1) {
    const photo = timed[index] as InterpolationInput;
    if (hasPosition(photo)) continue;

    const beforeIndex = previousAnchor[index] as number;
    const afterIndex = nextAnchor[index] as number;

    if (beforeIndex === -1) {
      unresolved.push({
        photoId: photo.id,
        reason: "no-anchor-before",
        anchorGapMinutes: null,
      });
      continue;
    }

    if (afterIndex === -1) {
      unresolved.push({
        photoId: photo.id,
        reason: "no-anchor-after",
        anchorGapMinutes: null,
      });
      continue;
    }

    const before = timed[beforeIndex] as InterpolationInput & LatLng;
    const after = timed[afterIndex] as InterpolationInput & LatLng;

    const beforeMs = (before.takenAt as Date).getTime();
    const afterMs = (after.takenAt as Date).getTime();
    const gapMs = afterMs - beforeMs;
    const gapMinutes = gapMs / MINUTE_MS;

    if (gapMs > maxGapMs) {
      unresolved.push({
        photoId: photo.id,
        reason: "gap-too-large",
        anchorGapMinutes: gapMinutes,
      });
      continue;
    }

    // Anchors sharing a timestamp to the millisecond: the fraction is 0/0, so
    // fall back to the earlier anchor rather than producing NaN.
    const fraction =
      gapMs === 0
        ? 0
        : ((photo.takenAt as Date).getTime() - beforeMs) / gapMs;

    const point = interpolateAlongGreatCircle(before, after, fraction);

    positions.push({
      photoId: photo.id,
      lat: point.lat,
      lng: point.lng,
      beforePhotoId: before.id,
      afterPhotoId: after.id,
      anchorGapMinutes: gapMinutes,
    });
  }

  return { positions, unresolved };
}
