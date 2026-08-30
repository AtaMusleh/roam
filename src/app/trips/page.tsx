import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { BlurhashCanvas } from "@/components/blurhash-canvas";
import { SiteNav } from "@/components/site-nav";
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
 * Live data, but not so live it should be recomputed per request. Matches the
 * home page: an hour is generous for an index that changes when someone
 * reseeds or renames a place.
 */
export const revalidate = 3600;

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
  const trips = await getTripsIndex();

  return (
    // `dark` scoped here, as on the home and trip pages, so the three agree
    // without depending on a document-level theme.
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <SiteNav />

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
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {trips.map((trip, index) => (
              <li
                key={trip.id}
                // The newest trip runs the full width and taller, so the index
                // has a lead rather than reading as an undifferentiated grid.
                className={index === 0 ? "sm:col-span-2 lg:col-span-3" : undefined}
              >
                <TripCard trip={trip} lead={index === 0} />
              </li>
            ))}
          </ul>
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
      className="group block h-full overflow-hidden rounded-lg border border-border/60 bg-card transition-colors hover:border-roam-accent/60 focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
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
              className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
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
