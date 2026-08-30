import { SiteNav } from "@/components/site-nav";

/**
 * Shown the instant `/trips` is navigated to, while the payload is on its way.
 *
 * Without it the browser sits on the previous page doing nothing visible until
 * the server responds, which reads as the click having been ignored — so the
 * click gets repeated. The skeleton is the fix for that, not a decoration: it
 * is the acknowledgement.
 *
 * Laid out to the same grid as the real page — one wide lead card above a
 * three-up row — so the content lands where the skeleton already is rather
 * than shifting under the reader.
 *
 * The nav renders signed-out here. `loading.tsx` is a static fallback and
 * cannot read the session; a moment of no upload link before the real page
 * arrives is a much smaller problem than making this dynamic too.
 */
export default function TripsLoading() {
  return (
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

      <main
        aria-busy="true"
        aria-label="Loading trips"
        className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:py-14"
      >
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton lead />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </main>
    </div>
  );
}

function CardSkeleton({ lead = false }: { lead?: boolean }) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-border/60 bg-card ${
        lead ? "sm:col-span-2 lg:col-span-3" : ""
      }`}
    >
      <div
        className={`animate-pulse bg-muted/30 ${lead ? "aspect-[16/7]" : "aspect-[3/2]"}`}
      />

      <div className="space-y-3 p-5">
        <div
          className={`animate-pulse rounded bg-muted/30 ${lead ? "h-7 w-72" : "h-5 w-44"}`}
        />
        <div className="h-4 w-40 animate-pulse rounded bg-muted/20" />

        <div className="flex gap-6 pt-1">
          <div className="h-4 w-20 animate-pulse rounded bg-muted/20" />
          <div className="h-4 w-24 animate-pulse rounded bg-muted/20" />
          <div className="h-4 w-16 animate-pulse rounded bg-muted/20" />
        </div>
      </div>
    </div>
  );
}
