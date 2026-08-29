/**
 * Unsplash search, for real photography in the demo trip.
 *
 * The generated dataset is synthetic in everything except its geography, and
 * for a long time its images were random placeholders — which made the demo
 * actively misleading, showing waterfalls under "Colosseo". This fetches actual
 * photographs of each place instead.
 *
 * ## The API's terms, and what they require of us
 *
 * Unsplash is free and asks for specific things in return. All of them are
 * honoured here or in the components that render the result:
 *
 *  - **Attribution.** Every photograph must credit its photographer by name,
 *    linked to their profile, and credit Unsplash. `PhotoGrid` renders this.
 *  - **UTM parameters** on those links, so Unsplash can see the referral.
 *    `withReferral` below adds them.
 *  - **Hotlinking.** The image must be served from Unsplash's own URLs rather
 *    than copied onto our storage, which is why only the URL is cached.
 *  - **Rate limits.** Fifty requests an hour on the demo tier. The cache means
 *    a full fetch happens once and is then committed; requests are spaced, and
 *    the budget is checked against the response headers as it goes.
 */

const API_ROOT = "https://api.unsplash.com";

/** Unsplash asks that referral links identify the application. */
const APP_NAME = "roam";

/** Most results Unsplash will return in one page. */
const MAX_PER_PAGE = 30;

/** Spacing between requests. The limit is hourly, but pacing is still polite. */
const REQUEST_SPACING_MS = 400;

const REQUEST_TIMEOUT_MS = 20_000;

export type Orientation = "landscape" | "portrait";

/** One photograph, reduced to what the demo needs and the terms require. */
export interface UnsplashPhoto {
  id: string;
  /** Hotlinked, as the terms require. Never copied to our own storage. */
  url: string;
  width: number;
  height: number;
  blurhash: string | null;
  photographerName: string;
  /** Profile link, carrying the referral parameters. */
  photographerUrl: string;
  /** What the photograph is of, when Unsplash knows. */
  description: string | null;
}

export interface UnsplashSearchResult {
  photos: UnsplashPhoto[];
  /** Requests left in this hour, as reported by Unsplash. */
  remaining: number | null;
}

/** Adds the referral parameters Unsplash's terms require on outbound links. */
export function withReferral(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("utm_source", APP_NAME);
  parsed.searchParams.set("utm_medium", "referral");
  return parsed.toString();
}

/** The Unsplash link to credit alongside the photographer. */
export const UNSPLASH_HOME = withReferral("https://unsplash.com/");

/**
 * Rewrites an Unsplash image URL to ask for a different size.
 *
 * The cached URL is the `regular` variant, about 1080px wide — right for a
 * thumbnail in a grid and visibly soft filling a screen. Unsplash serves its
 * images through an imaging CDN that takes the size as query parameters, so a
 * larger version is the same URL with a bigger `w`. Nothing is copied or
 * re-hosted; this is still the hotlink the terms require.
 *
 * `naturalWidth` caps the request at the photograph's real size. Asking for
 * more than exists would return an upscaled image — bytes spent on pixels the
 * photographer never took.
 *
 * Any URL that is not an Unsplash one is returned untouched, so a trip whose
 * photographs come from somewhere else still works.
 */
export function unsplashVariant(
  url: string,
  targetWidth: number,
  naturalWidth: number,
): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.hostname !== "images.unsplash.com") return url;

  parsed.searchParams.set("w", String(Math.round(Math.min(targetWidth, naturalWidth))));
  // `max` fits within the box without cropping, which is what the lightbox
  // wants: the whole photograph, never a centre crop of it.
  parsed.searchParams.set("fit", "max");
  parsed.searchParams.set("q", "85");
  parsed.searchParams.set("auto", "format");

  return parsed.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Reads one search result into our shape, or `null` if it is unusable.
 *
 * Parsed defensively rather than trusted: a result missing a photographer or a
 * URL cannot be shown within the terms, and dropping it is better than
 * rendering an uncredited photograph.
 */
function readPhoto(value: unknown): UnsplashPhoto | null {
  if (!isRecord(value)) return null;

  const id = readString(value["id"]);
  const width = value["width"];
  const height = value["height"];

  if (id === null || typeof width !== "number" || typeof height !== "number") {
    return null;
  }

  const urls = value["urls"];
  const url = isRecord(urls) ? readString(urls["regular"]) : null;
  if (url === null) return null;

  const user = value["user"];
  if (!isRecord(user)) return null;

  const photographerName = readString(user["name"]);
  const userLinks = user["links"];
  const profile = isRecord(userLinks) ? readString(userLinks["html"]) : null;

  if (photographerName === null || profile === null) return null;

  return {
    id,
    url,
    width,
    height,
    blurhash: readString(value["blur_hash"]),
    photographerName,
    photographerUrl: withReferral(profile),
    description:
      readString(value["description"]) ?? readString(value["alt_description"]),
  };
}

interface SearchOptions {
  query: string;
  orientation: Orientation;
  /** How many photographs are wanted; pages are fetched until this is met. */
  count: number;
  accessKey: string;
}

/**
 * Searches Unsplash, following pages until `count` results are collected.
 *
 * Returns fewer than asked for when the search runs out — the caller decides
 * what to do about a place with more photographs than Unsplash has pictures of.
 */
export async function searchPhotos({
  query,
  orientation,
  count,
  accessKey,
}: SearchOptions): Promise<UnsplashSearchResult> {
  const collected = new Map<string, UnsplashPhoto>();
  let remaining: number | null = null;
  let page = 1;

  while (collected.size < count) {
    if (page > 1) await sleep(REQUEST_SPACING_MS);

    const url = new URL(`${API_ROOT}/search/photos`);
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", orientation);
    url.searchParams.set("per_page", String(MAX_PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("content_filter", "high");

    const response = await fetch(url, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const headerRemaining = response.headers.get("x-ratelimit-remaining");
    if (headerRemaining !== null) remaining = Number(headerRemaining);

    if (response.status === 403) {
      throw new Error(
        "Unsplash refused the request: the hourly rate limit is spent, or the access key is wrong.",
      );
    }

    if (!response.ok) {
      throw new Error(
        `Unsplash replied ${response.status} ${response.statusText} for "${query}"`,
      );
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body["results"])) {
      throw new Error(`Unsplash returned an unreadable body for "${query}"`);
    }

    const results = body["results"];
    for (const raw of results) {
      const photo = readPhoto(raw);
      // Keyed by id so the same photograph appearing on two pages counts once.
      if (photo) collected.set(photo.id, photo);
    }

    const totalPages = body["total_pages"];
    const lastPage = typeof totalPages === "number" ? totalPages : 1;

    if (results.length === 0 || page >= lastPage) break;
    page += 1;
  }

  return { photos: [...collected.values()].slice(0, count), remaining };
}
