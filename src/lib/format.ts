/**
 * Date and number formatting for the trip view.
 *
 * ## Trip-local time
 *
 * Timestamps are stored as absolute UTC instants, but a journal should read in
 * the time the traveller experienced: a café visit at 11:10 in Rome belongs at
 * 11:10, not at 09:10 where UTC puts it, and not at whatever o'clock it is for
 * whoever happens to be reading. So every function here takes the trip's
 * `utcOffsetMinutes` and renders the wall clock at the place the photographs
 * were taken.
 *
 * The offset is applied by shifting the instant and then formatting in UTC.
 * That is a trick, but a sound one: `Intl` can only format in a named IANA zone
 * or the host's, and a fixed offset is neither. Shifting produces exactly the
 * digits the traveller's watch showed.
 *
 * ## Where the offset comes from
 *
 * `Trip.utcOffsetMinutes`, which the demo seeds at 120 for Rome in May. A real
 * import would derive it per trip rather than being told: a photo's EXIF
 * `DateTimeOriginal` is a local wall-clock reading with no zone, and the same
 * photo's GPS timestamp (or the file's UTC mtime) is the instant. The
 * difference between the two, rounded to the nearest quarter hour, is the
 * offset the camera was set to.
 *
 * A single offset per trip is a simplification. It is right for a week in one
 * city and wrong for a trip that crosses zones or a DST boundary, which would
 * need the offset stored per visit — or an IANA zone name, so the rules can be
 * applied per instant.
 *
 * ## Why the locale is pinned
 *
 * These strings are produced during server rendering and again during
 * hydration. `toLocaleTimeString()` with no arguments reads the host's locale,
 * which differs between the server and the visitor's browser, so the two passes
 * disagree and React reports a hydration mismatch. Pinning makes the output a
 * pure function of its arguments.
 */

/** Pinned so server and client render byte-identical strings. */
const LOCALE = "en-GB";

const MINUTE_MS = 60_000;

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const dayFormatter = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

const shortDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Moves an instant so that formatting it in UTC yields the trip's local
 * wall clock. The result is not a meaningful instant — only its digits are.
 */
function toTripWallClock(date: Date, utcOffsetMinutes: number): Date {
  return new Date(date.getTime() + utcOffsetMinutes * MINUTE_MS);
}

/** `11:10` in the trip's local time. */
export function formatTripTime(date: Date, utcOffsetMinutes: number): string {
  return timeFormatter.format(toTripWallClock(date, utcOffsetMinutes));
}

/** `Monday 11 May` in the trip's local time. */
export function formatTripDay(date: Date, utcOffsetMinutes: number): string {
  return dayFormatter.format(toTripWallClock(date, utcOffsetMinutes));
}

/** `11 May 2026 – 15 May 2026`, collapsing to one date for a single day. */
export function formatTripDateRange(
  start: Date,
  end: Date,
  utcOffsetMinutes: number,
): string {
  const from = shortDateFormatter.format(toTripWallClock(start, utcOffsetMinutes));
  const to = shortDateFormatter.format(toTripWallClock(end, utcOffsetMinutes));
  return from === to ? from : `${from} – ${to}`;
}

/**
 * A key identifying the local calendar day an instant falls on, for grouping.
 * Sortable as a string, which is what the timeline relies on.
 *
 * The offset matters here as much as in the times: a dinner at 00:30 in Rome is
 * 22:30 the previous day in UTC, and grouping on the wrong one files the last
 * night of a trip under the day before.
 */
export function tripDayKey(date: Date, utcOffsetMinutes: number): string {
  return toTripWallClock(date, utcOffsetMinutes).toISOString().slice(0, 10);
}

/** `UTC+02:00`, for showing which clock the times are on. */
export function formatUtcOffset(utcOffsetMinutes: number): string {
  const sign = utcOffsetMinutes < 0 ? "−" : "+";
  const total = Math.abs(utcOffsetMinutes);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
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
