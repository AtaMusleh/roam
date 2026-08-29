/**
 * A serialising rate limiter for polite use of free public APIs.
 *
 * Both geocoding services Roam depends on are run by volunteers and funded by
 * donations. Neither charges, and neither has to keep serving us. The etiquette
 * is the price, and it is a fair one.
 */

/**
 * The User-Agent sent to both OpenStreetMap services.
 *
 * Nominatim's policy requires one that identifies the application, and
 * Overpass operators expect the same courtesy: the point is that whoever runs
 * the server can get in touch with whoever is generating the traffic, instead
 * of having to block an anonymous client. `NOMINATIM_CONTACT` supplies the
 * contact half — an email address or project URL.
 */
export function userAgent(): string {
  const contact = process.env.NOMINATIM_CONTACT?.trim();

  return contact
    ? `Roam/0.1 (travel photo journey app; ${contact})`
    : "Roam/0.1 (travel photo journey app; https://github.com/roam-app/roam)";
}

export interface RateLimiter {
  /**
   * Runs `task` after every previously scheduled task has finished, and no
   * sooner than `spacingMs` after the previous one started.
   */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Creates a limiter that lets exactly one task run at a time, spaced out.
 *
 * Each caller appends to a single promise chain, so concurrent callers queue
 * rather than firing together: `Promise.all` over fifty coordinates takes a
 * minute and makes fifty properly spaced requests, instead of getting the IP
 * blocked.
 *
 * A limiter is per-process, which is the honest limit of this approach — two
 * server instances would each keep their own pace. Caching is what really
 * keeps the volume down; a deployment fanning out across many instances would
 * need a shared limiter (a Redis token bucket, or routing lookups through one
 * worker).
 */
export function createRateLimiter(spacingMs: number): RateLimiter {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStartedAt = 0;

  return {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      const scheduled = tail.then(async () => {
        const waitFor = lastStartedAt + spacingMs - Date.now();
        if (waitFor > 0) await sleep(waitFor);

        lastStartedAt = Date.now();
        return task();
      });

      // The tail must not inherit a rejection, or one failed request would
      // poison every request queued behind it.
      tail = scheduled.catch(() => undefined);

      return scheduled;
    },
  };
}
