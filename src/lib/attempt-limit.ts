/**
 * A fixed-window limiter for failed sign-in attempts.
 *
 * One password with no lockout is a password that can be guessed at whatever
 * rate the network allows. Five tries a quarter of an hour turns an online
 * guessing attack into an offline problem, which is a different and much
 * harder one.
 *
 * ## What this is not
 *
 * The counters live in a `Map` in this process. That means they reset on
 * deploy, and that two server instances would each allow five attempts rather
 * than five between them. For a single-owner site on a single instance that is
 * the right amount of machinery; anything larger wants a shared store (a Redis
 * counter keyed the same way), and the shape here is deliberately the shape
 * that would port to one.
 *
 * Only failures are counted. A correct password clears the record, so the
 * owner signing in repeatedly is never locked out by their own success.
 */

/** Attempts allowed inside one window. */
export const SIGN_IN_ATTEMPT_LIMIT = 5;

/** Length of that window. */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Cap on how many distinct keys are tracked.
 *
 * Every unseen IP would otherwise add an entry that lives for the window, which
 * makes the map itself a way to spend the server's memory. Past the cap the
 * oldest entries are dropped — losing a count is a much smaller problem than
 * unbounded growth, and a real attacker is one key hammering away, not a
 * million keys knocking once.
 */
const MAX_TRACKED_KEYS = 10_000;

interface Window {
  count: number;
  /** When the current window began. */
  startedAt: number;
}

const windows = new Map<string, Window>();

export interface AttemptVerdict {
  allowed: boolean;
  /** How long until the window resets, in seconds. Zero when allowed. */
  retryAfterSeconds: number;
}

function prune(now: number): void {
  for (const [key, window] of windows) {
    if (now - window.startedAt >= SIGN_IN_WINDOW_MS) windows.delete(key);
  }

  // Still over the cap after dropping the expired ones: shed from the front,
  // which is insertion order and so the least recently started.
  if (windows.size > MAX_TRACKED_KEYS) {
    const excess = windows.size - MAX_TRACKED_KEYS;
    let dropped = 0;

    for (const key of windows.keys()) {
      windows.delete(key);
      dropped += 1;
      if (dropped >= excess) break;
    }
  }
}

/**
 * Whether `key` may attempt now, without recording anything.
 *
 * Checked before the password is compared, so a locked-out caller learns
 * nothing about whether their guess was right.
 */
export function checkAttempt(key: string, now = Date.now()): AttemptVerdict {
  const window = windows.get(key);

  if (window === undefined || now - window.startedAt >= SIGN_IN_WINDOW_MS) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (window.count < SIGN_IN_ATTEMPT_LIMIT) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.ceil(
      (window.startedAt + SIGN_IN_WINDOW_MS - now) / 1000,
    ),
  };
}

/** Records one failure against `key`. */
export function recordFailure(key: string, now = Date.now()): void {
  prune(now);

  const window = windows.get(key);

  if (window === undefined || now - window.startedAt >= SIGN_IN_WINDOW_MS) {
    windows.set(key, { count: 1, startedAt: now });
    return;
  }

  window.count += 1;
}

/** Forgets `key`'s failures, after a correct password. */
export function clearAttempts(key: string): void {
  windows.delete(key);
}

/** Test seam: drops every counter. */
export function resetAttemptLimiter(): void {
  windows.clear();
}
