import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buildTimeline } from "@/components/timeline/build";
import { TripStats } from "@/components/trip-stats";
import { TripView } from "@/components/trip-view";
import { formatTripDateRange, pluralise } from "@/lib/format";
import { editsAllowed } from "@/lib/place-edits";
import { getTripBySlug, getTripStats, photographedRange } from "@/lib/queries";

export async function generateMetadata({
  params,
}: PageProps<"/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const trip = await getTripBySlug(slug);

  if (!trip || !trip.isPublic) {
    return { title: "Not found" };
  }

  const range = photographedRange(trip.places);

  return {
    title: `${trip.name} · Roam`,
    description: `${formatTripDateRange(
      range?.start ?? trip.startDate,
      range?.end ?? trip.endDate,
      trip.utcOffsetMinutes,
    )} — ${pluralise(trip.places.length, "place")}.`,
  };
}

export default async function TripPage({ params }: PageProps<"/[slug]">) {
  const { slug } = await params;
  const trip = await getTripBySlug(slug);

  // A private trip is indistinguishable from a missing one, on purpose: a 403
  // would confirm that this slug belongs to something.
  if (!trip || !trip.isPublic) notFound();

  const stats = await getTripStats(trip.id, trip.utcOffsetMinutes);
  const days = buildTimeline(trip.places, trip.utcOffsetMinutes);
  const range = photographedRange(trip.places);

  return (
    // `dark` is scoped to this screen rather than set on the document, so the
    // rest of the app keeps whatever theme it chooses. The trip view is dark
    // because the photographs and the map should be the brightest things on it.
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <header className="shrink-0 border-b border-border/60 px-4 py-4 sm:px-6 lg:py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
              {trip.name}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatTripDateRange(
                range?.start ?? trip.startDate,
                range?.end ?? trip.endDate,
                trip.utcOffsetMinutes,
              )}
            </p>
          </div>

          <div className="lg:w-auto lg:min-w-[26rem]">
            <TripStats stats={stats} />
          </div>
        </div>
      </header>

      {/* `ALLOW_EDITS` is server-only, so whether editing is available has to be
          decided here and handed down. */}
      <TripView trip={trip} days={days} canEdit={editsAllowed()} />
    </div>
  );
}
