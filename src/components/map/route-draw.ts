/**
 * The geometry behind the trip page's route animation.
 *
 * Separated from the map component because it is arithmetic with no Mapbox in
 * it, which makes it testable on its own — and because the reason for the
 * approach is worth stating away from the wiring.
 *
 * ## Why the geometry grows rather than the dash pattern moving
 *
 * The obvious way to reveal a line in Mapbox is `line-dasharray`: one long dash
 * that grows until it covers the whole line. It does not work here, for two
 * reasons.
 *
 * The first is that dash lengths are multiples of `line-width`, which is a
 * constant number of *pixels*. How many of those it takes to span the route
 * therefore depends on the zoom, and the brief requires the map to stay
 * interactive while the line draws — so a reader who zooms out mid-draw would
 * watch the line snap back to a fraction of itself.
 *
 * The second is that this route is already dashed, deliberately: it is an
 * inference about a journey rather than a recorded track, and it is drawn as
 * dots to say so. Spending `line-dasharray` on the animation would mean giving
 * that up for a solid line.
 *
 * Growing the geometry keeps both. The dash pattern stays exactly as it was,
 * the line is measured in metres so zoom is irrelevant, and nothing touches the
 * camera — the animation only ever calls `setData` on a source.
 */

import { haversineDistance, interpolate } from "@/lib/geo";
import type { LatLng } from "@/lib/geo";

/** A route measured once, so each frame is a lookup rather than a re-measure. */
export interface MeasuredRoute {
  /** Every place, in visit order. */
  points: LatLng[];
  /**
   * How far along the whole route each place sits, from 0 to 1.
   *
   * The first is always 0 and the last always 1. This is what decides when
   * each marker appears: the line has reached a place when the progress passes
   * that place's fraction.
   */
  fractions: number[];
}

/**
 * Measures the route by great-circle distance between consecutive places.
 *
 * Distance rather than place count, so the line moves at a constant speed
 * across the map instead of pausing over dense clusters and racing across the
 * gaps. A trip with nine places in one neighbourhood and one an hour away
 * should spend most of the animation on that last leg, because that is what
 * the journey looked like.
 *
 * A route whose places are all at the same coordinates has no length to divide
 * by; it falls back to spacing the fractions evenly so the markers still appear
 * in order rather than all at once.
 */
export function measureRoute(places: readonly LatLng[]): MeasuredRoute {
  const points = places.map((place) => ({ lat: place.lat, lng: place.lng }));

  if (points.length === 0) return { points, fractions: [] };

  const cumulative: number[] = [0];
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;

    total += haversineDistance(previous, current);
    cumulative.push(total);
  }

  const fractions =
    total > 0
      ? cumulative.map((distance) => distance / total)
      : points.map((_, index) =>
          points.length === 1 ? 0 : index / (points.length - 1),
        );

  return { points, fractions };
}

/**
 * The coordinates of the route drawn `progress` of the way along.
 *
 * The last coordinate is interpolated along whichever leg the progress falls
 * on, so the line's head moves smoothly between places rather than jumping
 * from one to the next.
 *
 * Returned as `[lng, lat]` pairs, which is GeoJSON's order and the reverse of
 * how they are held everywhere else in this codebase.
 */
export function routeAt(
  route: MeasuredRoute,
  progress: number,
): [number, number][] {
  const { points, fractions } = route;
  if (points.length === 0) return [];

  const clamped = Math.min(1, Math.max(0, progress));

  const coordinates: [number, number][] = [];

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const fraction = fractions[i];
    if (point === undefined || fraction === undefined) continue;

    if (fraction <= clamped) {
      coordinates.push([point.lng, point.lat]);
      continue;
    }

    // The first place past the head: draw partway to it and stop.
    const previous = points[i - 1];
    const previousFraction = fractions[i - 1];

    if (previous !== undefined && previousFraction !== undefined) {
      const span = fraction - previousFraction;
      // A zero-length leg would divide by zero; there is nothing to draw
      // across it anyway.
      const along = span > 0 ? (clamped - previousFraction) / span : 0;

      // Nothing along it yet: the head is exactly the previous place, already
      // pushed. Adding it again would make a two-point line of one point,
      // which renders as nothing but is a lie about what has been drawn.
      if (along > 0) {
        const head = interpolate(previous, point, along);
        coordinates.push([head.lng, head.lat]);
      }
    }

    break;
  }

  return coordinates;
}

/**
 * How many places the line has reached at `progress`.
 *
 * Used to decide which markers are visible. Always at least one: the first
 * place is where the line starts, so it is there from the first frame.
 */
export function placesReached(route: MeasuredRoute, progress: number): number {
  let reached = 0;

  for (const fraction of route.fractions) {
    if (fraction <= progress) reached += 1;
    else break;
  }

  return Math.max(1, reached);
}
