import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { BlurhashCanvas } from "@/components/blurhash-canvas";
import { RevealGroup } from "@/components/motion/reveal";
import { SmoothScroll } from "@/components/motion/smooth-scroll";
import { SiteNav } from "@/components/site-nav";
import { isSignedIn } from "@/lib/auth";
import { formatTripDateRange } from "@/lib/format";
import { getTripsIndex } from "@/lib/queries";
import type { TripSummary } from "@/lib/queries";
import { SITE_NAME } from "@/lib/site";
import { UNSPLASH_HOME, unsplashVariant } from "@/lib/unsplash";

export const metadata: Metadata = {
  title: `Trips · ${SITE_NAME}`,
  description:
    "Every journey Roam has reconstructed from photographs — the places, the days, and the route between them.",
};

/**
 * Rendered per request rather than cached.
 *
 * The nav shows an upload link to whoever is signed in, and reading the session
 * cookie to decide that opts the whole route into dynamic rendering — a cached
 * document cannot vary by cookie.
 *
 * The *data* is cached regardless, in `getTripsIndex`, so what this costs per
 * request is a cookie read and a cache hit rather than a database round trip.
 */
export const dynamic = "force-dynamic";

/**
 * Widths the cover images are requested at.
 *
 * The first card is a wide banner and the rest are a two- or three-up grid, so
 * they need different sizes; asking for the banner's width everywhere would
 * send two thousand pixels of photograph into a four-hundred-pixel card.
 */
const LEAD_COVER_WIDTH = 1600;
const COVER_WIDTH = 900;

export default async function TripsPage() {
  // Logged here, on the server, before it is re-thrown to `error.tsx`.
  //
  // A failure inside a Server Component during a client-side navigation
  // surfaces to the browser as Next's own "This page couldn't load" and
  // nothing else — the message is redacted in production and the stack never
  // leaves the server. Without this the only evidence of what went wrong was a
  // digest, and the terminal stayed silent.
  let trips: TripSummary[];
  let signedIn: boolean;

  try {
    [trips, signedIn] = await Promise.all([getTripsIndex(), isSignedIn()]);
  } catch (error) {
    console.error(
      "[/trips] render failed:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    throw error;
  }

  return (
    // `dark` scoped here, as on the home and trip pages, so the three agree
    // without depending on a document-level theme.
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <SmoothScroll />

      <SiteNav signedIn={signedIn} />

      <header className="border-b border-border/60 px-6 py-12 sm:py-16">
        <div className="mx-auto w-full max-w-6xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-roam-accent">
            Trips
          </p>

          <h1 className="mt-3 max-w-3xl text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Journeys reconstructed from photographs.
          </h1>

          <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
            Each one started as a folder of images with coordinates buried in
            them. Nothing here was typed in by hand — the places, the visits and
            the order they happened in were all worked out from the files.
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:py-14">
        {trips.length === 0 ? (
          <EmptyState />
        ) : (
          <RevealGroup
            as="ul"
            itemAs="li"
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            // The newest trip runs the full width and taller, so the index has
            // a lead rather than reading as an undifferentiated grid.
            itemClassName={trips.map((_, index) =>
              index === 0 ? "sm:col-span-2 lg:col-span-3" : undefined,
            )}
          >
            {trips.map((trip, index) => (
              <TripCard key={trip.id} trip={trip} lead={index === 0} />
            ))}
          </RevealGroup>
        )}
      </main>

      <footer className="border-t border-border/60 py-8">
        <p className="mx-auto w-full max-w-6xl px-6 text-xs text-muted-foreground">
          Photographs from{" "}
          <a
            href={UNSPLASH_HOME}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Unsplash
          </a>
          , each credited to its photographer on the trip it appears in.
        </p>
      </footer>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border/60 px-6 py-16 text-center">
      <p className="text-sm font-medium">No trips yet.</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Seed the demos with{" "}
        <code className="rounded bg-muted/40 px-1.5 py-0.5 text-xs">
          npm run seed:all
        </code>
        , then reload.
      </p>
    </div>
  );
}

function TripCard({ trip, lead }: { trip: TripSummary; lead: boolean }) {
  const { cover, stats } = trip;
  const width = lead ? LEAD_COVER_WIDTH : COVER_WIDTH;
  const src = cover === null ? null : unsplashVariant(cover.url, width, cover.width);

  return (
    <Link
      href={`/${trip.slug}`}
      // The lift is a translation and a shadow, not a margin: moving the box
      // itself would reflow the grid row every time a pointer crossed a card.
      //
      // The transition names `translate`, not `transform`. Tailwind v4 compiles
      // `-translate-y-1` to the standalone `translate` property, and a
      // transition on `transform` does not cover it — the lift snapped.
      //
      // `motion-reduce:` drops it, since Tailwind's variant is driven by the
      // same media query the rest of this respects.
      className="group block h-full overflow-hidden rounded-lg border border-border/60 bg-card transition-[translate,box-shadow,border-color] duration-150 ease-out hover:-translate-y-1 hover:border-roam-accent/60 hover:shadow-[0_12px_32px_oklch(0_0_0/45%)] focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div
        className={`relative isolate overflow-hidden bg-muted/30 ${
          lead ? "aspect-[16/7]" : "aspect-[3/2]"
        }`}
      >
        {cover !== null && src !== null ? (
          <>
            {cover.blurhash !== null && (
              <BlurhashCanvas hash={cover.blurhash} className="-z-10" />
            )}
            <Image
              src={src}
              alt=""
              fill
              sizes={
                lead
                  ? "(min-width: 640px) 72rem, 100vw"
                  : "(min-width: 1024px) 22rem, (min-width: 640px) 50vw, 100vw"
              }
              // A slow zoom on hover, so a card reads as something to open. The
              // image is the only thing that moves; the text stays put.
              // `scale`, not `transform`, for the same Tailwind v4 reason as
              // the lift above.
              className="object-cover transition-[scale] duration-500 ease-out group-hover:scale-[1.06] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No photographs yet
          </div>
        )}

        {cover?.photographerName != null && (
          <p className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2.5 py-1 text-[10px] text-white/70">
            {cover.photographerName} / Unsplash
          </p>
        )}
      </div>

      <div className="p-5">
        <h2
          className={`font-semibold tracking-tight ${lead ? "text-xl sm:text-2xl" : "text-base"}`}
        >
          {trip.name}
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          {formatTripDateRange(trip.start, trip.end, trip.utcOffsetMinutes)}
        </p>

        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
          <Count value={stats.placeCount} label="places" />
          <Count value={stats.photoCount} label="photographs" />
          <Count value={stats.dayCount} label="days" />
        </dl>
      </div>
    </Link>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="sr-only">{label}</dt>
      <dd className="font-medium">{value.toLocaleString("en-GB")}</dd>
      <span aria-hidden className="text-xs text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
