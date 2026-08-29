/**
 * Date and number formatting for the trip view.
 *
 * ## Why everything here pins a locale and a time zone
 *
 * These strings are produced during server rendering and again during
 * hydration. `toLocaleTimeString()` with no arguments reads the *host's*
 * locale and zone, which differ between the server and the visitor's browser,
 * so the two passes disagree and React reports a hydration mismatch. Pinning
 * both makes the output a pure function of the timestamp.
 *
 * ## A known limitation
 *
 * Times are shown in UTC, which is not the time the traveller experienced.
 * `Visit.arrivedAt` is an absolute instant, and `Trip` records nothing about
 * where in the world the trip happened, so there is no offset to render it
 * back into. The Rome demo was photographed at UTC+2: a café visit at 11:10
 * local displays here as 09:10.
 *
 * Formatting in the *viewer's* zone would be no better — it would show a time
 * neither the traveller nor anyone else experienced, and it would vary by who
 * is looking. UTC is at least stable and honest.
 *
 * The fix is a UTC offset (or IANA zone) on `Trip`, captured at import from the
 * photos' EXIF local timestamps. Once that exists, this constant becomes a
 * per-trip value and every call site below already threads through it.
 */
export const TRIP_DISPLAY_TIME_ZONE = "UTC";

/** Pinned so server and client render byte-identical strings. */
const LOCALE = "en-GB";

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TRIP_DISPLAY_TIME_ZONE,
});

const dayFormatter = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: TRIP_DISPLAY_TIME_ZONE,
});

const shortDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: TRIP_DISPLAY_TIME_ZONE,
});

/** `09:10` */
export function formatTripTime(date: Date): string {
  return timeFormatter.format(date);
}

/** `Monday 11 May` */
export function formatTripDay(date: Date): string {
  return dayFormatter.format(date);
}

/** `11 May 2026 – 15 May 2026`, collapsing to one date for a single day. */
export function formatTripDateRange(start: Date, end: Date): string {
  const from = shortDateFormatter.format(start);
  const to = shortDateFormatter.format(end);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * A key identifying the calendar day a timestamp falls on, for grouping.
 * Sortable as a string, which is what the timeline relies on.
 */
export function tripDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `41.8902°N, 12.4922°E` */
export function formatLatLng(lat: number, lng: number): string {
  const latPart = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}`;
  const lngPart = `${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  return `${latPart}, ${lngPart}`;
}

/** `3 photos`, `1 photo` */
export function pluralise(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
