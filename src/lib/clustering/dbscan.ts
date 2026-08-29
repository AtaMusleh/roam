/**
 * DBSCAN over geographic points.
 *
 * Density-based clustering is the right shape for a camera roll: the number of
 * places is not known ahead of time, clusters are wildly different sizes (nine
 * photos in a café, fifty-eight in a museum), and photos taken while walking
 * between stops genuinely belong to no cluster at all. k-means would have to be
 * told how many places there were and would force every stray photo into one.
 *
 * The metric is great-circle distance in metres, from `haversineDistance`.
 * Euclidean distance on raw degrees is wrong everywhere except the equator: at
 * Rome's latitude a degree of longitude is 828m shorter than a degree of
 * latitude, so a circular epsilon in degree-space is really an ellipse on the
 * ground, elongated east-west by 34%.
 */

import { haversineDistance } from "../geo";
import type { LatLng } from "../geo";

export interface DbscanOptions {
  /** Neighbourhood radius, in metres. */
  epsilonMeters: number;
  /**
   * How many points must lie within epsilon of a point — *including the point
   * itself* — for it to be a core point. This matches scikit-learn's
   * `min_samples`, so `minPoints = 1` makes every point its own cluster.
   */
  minPoints: number;
}

export interface DbscanCluster<T> {
  /** Every point in the cluster: core points and border points together. */
  points: T[];
  /**
   * Just the core points. Exposed because density-reachability is defined
   * relative to these — anything within epsilon of a core point belongs to its
   * cluster, which is how the pipeline later attaches interpolated photos.
   */
  corePoints: T[];
}

export interface DbscanResult<T> {
  clusters: DbscanCluster<T>[];
  /** Points in no cluster: too far from everything, or in too thin a crowd. */
  noise: T[];
}

/** Label for a point that has not been reached yet. */
const UNVISITED = -2;

/** Label for a point currently considered noise. May still be reclaimed. */
const NOISE = -1;

/**
 * Clusters points by density.
 *
 * Every point ends up in exactly one of three states:
 *
 *  - **Core** — has at least `minPoints` neighbours within `epsilonMeters`,
 *    itself included. Core points are the dense interior of a cluster and are
 *    what the cluster grows from: the search expands outward through them.
 *  - **Border** — inside some core point's neighbourhood, but not dense enough
 *    to be core itself. It joins that cluster but the search stops there, so a
 *    cluster cannot creep outward through a sparse fringe.
 *  - **Noise** — neither. Not dense, and not near anything dense. Reported
 *    separately rather than forced into the nearest cluster, because "this
 *    photo was taken between two places" is a real answer.
 *
 * A border point equidistant from two clusters is assigned to whichever
 * cluster reaches it first. This is the classic DBSCAN ambiguity; it is
 * deterministic here because points are always visited in input order.
 *
 * Region queries are a linear scan, making this O(n²) in distance
 * computations. For a camera roll — hundreds to low thousands of photos — that
 * is a few hundred thousand haversines and runs in milliseconds. A trip large
 * enough to care would want a spatial index behind `regionQuery` and nothing
 * else here would change.
 */
export function dbscan<T extends LatLng>(
  points: readonly T[],
  options: DbscanOptions,
): DbscanResult<T> {
  const { epsilonMeters, minPoints } = options;

  if (!(epsilonMeters > 0)) {
    throw new Error(`epsilonMeters must be positive, got ${epsilonMeters}`);
  }
  if (!Number.isInteger(minPoints) || minPoints < 1) {
    throw new Error(`minPoints must be a positive integer, got ${minPoints}`);
  }

  const count = points.length;
  const labels = new Array<number>(count).fill(UNVISITED);
  const core = new Array<boolean>(count).fill(false);

  /** Indices of every point within epsilon of `index`, including itself. */
  const regionQuery = (index: number): number[] => {
    const origin = points[index] as LatLng;
    const found: number[] = [];

    for (let other = 0; other < count; other += 1) {
      if (haversineDistance(origin, points[other] as LatLng) <= epsilonMeters) {
        found.push(other);
      }
    }

    return found;
  };

  let clusterCount = 0;

  for (let seed = 0; seed < count; seed += 1) {
    if (labels[seed] !== UNVISITED) continue;

    const neighbours = regionQuery(seed);

    if (neighbours.length < minPoints) {
      // Not core. Provisional only — a later cluster may still reach this
      // point and claim it as a border point.
      labels[seed] = NOISE;
      continue;
    }

    const clusterId = clusterCount;
    clusterCount += 1;

    core[seed] = true;
    labels[seed] = clusterId;

    // Breadth-first growth through core points. The queue is appended to as it
    // is walked, so `frontier.length` deliberately changes during the loop.
    const frontier = neighbours;

    for (let cursor = 0; cursor < frontier.length; cursor += 1) {
      const candidate = frontier[cursor] as number;

      if (labels[candidate] === NOISE) {
        // Reclaimed: it sits inside a core point's neighbourhood after all, so
        // it is a border point of this cluster rather than noise. It is not
        // expanded from — that is what keeps clusters from chaining through
        // sparse regions.
        labels[candidate] = clusterId;
        continue;
      }

      if (labels[candidate] !== UNVISITED) continue;

      labels[candidate] = clusterId;

      const candidateNeighbours = regionQuery(candidate);
      if (candidateNeighbours.length >= minPoints) {
        // Core: the cluster keeps growing outward from here.
        core[candidate] = true;
        for (const reachable of candidateNeighbours) {
          frontier.push(reachable);
        }
      }
    }
  }

  const clusters: DbscanCluster<T>[] = Array.from(
    { length: clusterCount },
    () => ({ points: [], corePoints: [] }),
  );
  const noise: T[] = [];

  for (let index = 0; index < count; index += 1) {
    const point = points[index] as T;
    const label = labels[index] as number;

    if (label === NOISE || label === UNVISITED) {
      noise.push(point);
      continue;
    }

    const cluster = clusters[label] as DbscanCluster<T>;
    cluster.points.push(point);
    if (core[index]) cluster.corePoints.push(point);
  }

  return { clusters, noise };
}
