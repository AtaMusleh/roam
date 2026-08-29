/**
 * Pure geospatial helpers. No imports, no I/O, no randomness — everything here
 * is a total function of its arguments so it can be unit-tested directly.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** IUGG mean Earth radius, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

function toDegrees(radians: number): number {
  return radians * RAD_TO_DEG;
}

/** Wraps a longitude into [-180, 180). */
export function normalizeLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Great-circle distance between two points, in metres.
 *
 * Uses the haversine formula, which stays numerically stable at the small
 * distances this app cares about (photos metres apart around one café), unlike
 * the spherical law of cosines.
 */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b.lng - a.lng);

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);

  const h =
    sinHalfDLat * sinHalfDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

  // Clamp guards against h drifting a hair above 1 for antipodal points.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Spherical centroid of a set of points.
 *
 * Averages the points as unit vectors rather than averaging latitude and
 * longitude, so a cluster straddling the antimeridian lands in the right place
 * instead of halfway around the world. Returns `null` for an empty input, and
 * for the degenerate case where the vectors cancel out (e.g. exactly antipodal
 * pairs) and no centroid is defined.
 */
export function centroid(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;

  let x = 0;
  let y = 0;
  let z = 0;

  for (const point of points) {
    const lat = toRadians(point.lat);
    const lng = toRadians(point.lng);
    const cosLat = Math.cos(lat);

    x += cosLat * Math.cos(lng);
    y += cosLat * Math.sin(lng);
    z += Math.sin(lat);
  }

  const n = points.length;
  x /= n;
  y /= n;
  z /= n;

  if (Math.hypot(x, y, z) < 1e-12) return null;

  return {
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
    lng: normalizeLongitude(toDegrees(Math.atan2(y, x))),
  };
}

/**
 * Moves a point by a local north/east offset in metres.
 *
 * A flat-Earth approximation around `origin`, which is exact enough for the
 * sub-kilometre offsets used to scatter photos around a place. Degenerates at
 * the poles, where an east offset has no meaning.
 */
export function offsetByMeters(
  origin: LatLng,
  northMeters: number,
  eastMeters: number,
): LatLng {
  const lat = origin.lat + toDegrees(northMeters / EARTH_RADIUS_M);
  const cosLat = Math.cos(toRadians(origin.lat));
  const lng =
    cosLat === 0
      ? origin.lng
      : origin.lng + toDegrees(eastMeters / (EARTH_RADIUS_M * cosLat));

  return { lat, lng: normalizeLongitude(lng) };
}

/**
 * Point at fraction `t` along the great circle from `a` to `b`.
 *
 * `t = 0` returns `a`, `t = 1` returns `b`. Values outside [0, 1] extrapolate.
 */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const lat1 = toRadians(a.lat);
  const lng1 = toRadians(a.lng);
  const lat2 = toRadians(b.lat);
  const lng2 = toRadians(b.lng);

  const angle = haversineDistance(a, b) / EARTH_RADIUS_M;
  const sinAngle = Math.sin(angle);

  // Coincident (or near-coincident) points: slerp is undefined, fall back to
  // the linear blend, which is what the limit converges to anyway.
  if (sinAngle < 1e-12) {
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: normalizeLongitude(a.lng + (b.lng - a.lng) * t),
    };
  }

  const wA = Math.sin((1 - t) * angle) / sinAngle;
  const wB = Math.sin(t * angle) / sinAngle;

  const x = wA * Math.cos(lat1) * Math.cos(lng1) + wB * Math.cos(lat2) * Math.cos(lng2);
  const y = wA * Math.cos(lat1) * Math.sin(lng1) + wB * Math.cos(lat2) * Math.sin(lng2);
  const z = wA * Math.sin(lat1) + wB * Math.sin(lat2);

  return {
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
    lng: normalizeLongitude(toDegrees(Math.atan2(y, x))),
  };
}
