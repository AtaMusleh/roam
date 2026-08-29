/**
 * Splitting a spatial cluster into visits.
 *
 * DBSCAN answers "where", not "when". Every photo taken at the same café is one
 * cluster whether it was one long morning or four separate mornings across a
 * fortnight — the coordinates are identical either way. A journey is a sequence
 * of stays, so the cluster has to be cut back apart along the time axis.
 *
 * The rule is a gap threshold: consecutive photos more than `maxGapMinutes`
 * apart are treated as belonging to different stays. Ninety minutes is a
 * deliberate compromise. Shorter, and a long museum visit where you stop
 * photographing over lunch splits in two. Longer, and a morning espresso plus
 * an evening drink at the same bar collapse into one implausible nine-hour
 * visit.
 */

export const DEFAULT_VISIT_GAP_MINUTES = 90;

export interface TemporalSplitOptions {
  /**
   * A gap longer than this between consecutive photos starts a new visit.
   * Defaults to `DEFAULT_VISIT_GAP_MINUTES`.
   */
  maxGapMinutes?: number;
}

export interface VisitSegment<T> {
  /** The segment's photos, in ascending time order. */
  points: T[];
  /** Timestamp of the first photo in the segment. */
  arrivedAt: Date;
  /** Timestamp of the last photo in the segment. */
  departedAt: Date;
}

const MINUTE_MS = 60_000;

/**
 * Cuts a set of points into time-contiguous segments.
 *
 * Note what `arrivedAt` and `departedAt` really are: the first and last photo,
 * not the true boundaries of the stay. You arrive somewhere before you take the
 * first photo and leave after the last, so every recovered visit is slightly
 * narrower than the real one. There is nothing in a camera roll that says
 * otherwise, and inventing a padding would be guessing.
 *
 * A single-photo segment is legitimate and gets `arrivedAt === departedAt`.
 * Points are not required to arrive sorted; a copy is sorted here.
 */
export function splitIntoVisits<T>(
  points: readonly T[],
  takenAt: (point: T) => Date,
  options: TemporalSplitOptions = {},
): VisitSegment<T>[] {
  const maxGapMinutes = options.maxGapMinutes ?? DEFAULT_VISIT_GAP_MINUTES;

  if (!(maxGapMinutes > 0)) {
    throw new Error(`maxGapMinutes must be positive, got ${maxGapMinutes}`);
  }

  if (points.length === 0) return [];

  const maxGapMs = maxGapMinutes * MINUTE_MS;

  const ordered = [...points].sort(
    (a, b) => takenAt(a).getTime() - takenAt(b).getTime(),
  );

  const segments: VisitSegment<T>[] = [];
  let current: T[] = [];

  const flush = (): void => {
    if (current.length === 0) return;

    const first = current[0] as T;
    const last = current[current.length - 1] as T;

    segments.push({
      points: current,
      arrivedAt: takenAt(first),
      departedAt: takenAt(last),
    });
    current = [];
  };

  let previousMs: number | null = null;

  for (const point of ordered) {
    const currentMs = takenAt(point).getTime();

    if (previousMs !== null && currentMs - previousMs > maxGapMs) {
      flush();
    }

    current.push(point);
    previousMs = currentMs;
  }

  flush();

  return segments;
}
