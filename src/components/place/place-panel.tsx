"use client";

import { X } from "lucide-react";

import { PhotoGrid } from "@/components/photo-grid";
import type { PhotoGridItem } from "@/components/photo-grid";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { formatLatLng, formatTripDay, formatTripTime, pluralise } from "@/lib/format";
import type { TripPlace } from "@/lib/queries";

interface PlacePanelProps {
  place: TripPlace | null;
  order: number | null;
  utcOffsetMinutes: number;
  onClose: () => void;
}

function photosOf(place: TripPlace): PhotoGridItem[] {
  return place.visits.flatMap((visit) =>
    visit.photos.map((photo) => ({
      id: photo.id,
      url: photo.url,
      width: photo.width,
      height: photo.height,
      blurhash: photo.blurhash,
      photographerName: photo.photographerName,
      photographerUrl: photo.photographerUrl,
    })),
  );
}

/** Name, position, when the traveller was there, and everything they took. */
function PlaceDetail({
  place,
  utcOffsetMinutes,
}: {
  place: TripPlace;
  utcOffsetMinutes: number;
}) {
  const photos = photosOf(place);

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Position</dt>
          <dd className="font-mono tabular-nums">
            {formatLatLng(place.lat, place.lng)}
          </dd>

          {place.address !== null && (
            <>
              <dt className="text-muted-foreground">Address</dt>
              <dd className="text-muted-foreground">{place.address}</dd>
            </>
          )}

          <dt className="text-muted-foreground">Photos</dt>
          <dd className="tabular-nums">{pluralise(photos.length, "photo")}</dd>
        </dl>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {pluralise(place.visits.length, "visit")}
        </h3>

        <ul className="space-y-1 text-xs">
          {place.visits.map((visit) => (
            <li key={visit.id} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">
                {formatTripDay(visit.arrivedAt, utcOffsetMinutes)}
              </span>
              <span className="font-mono tabular-nums">
                {formatTripTime(visit.arrivedAt, utcOffsetMinutes)}–
                {formatTripTime(visit.departedAt, utcOffsetMinutes)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <PhotoGrid
          photos={photos}
          sizes="(min-width: 1024px) 10rem, 30vw"
          className="columns-2 sm:columns-2"
        />
      </section>
    </div>
  );
}

function PanelHeading({ place, order }: { place: TripPlace; order: number | null }) {
  return (
    <div className="flex items-start gap-3">
      {order !== null && (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-roam-accent text-xs font-semibold tabular-nums text-roam-accent-foreground">
          {order}
        </span>
      )}
      <h2 className="text-base leading-snug font-semibold">{place.name}</h2>
    </div>
  );
}

/**
 * The detail view for a selected place.
 *
 * Two presentations of the same content, because the right shape differs by
 * screen. On a phone it is a sheet from the bottom, the usual gesture for
 * "more about this" over a map. On a desktop it is a panel floating at the
 * map's left edge, where it can sit open while the traveller keeps looking at
 * the route — the map stays the subject and the panel annotates it.
 *
 * Exactly one of them is mounted, chosen by a media query rather than by
 * hiding the other with a breakpoint class. That is not a preference: a sheet
 * renders a full-screen overlay through a portal to catch clicks outside
 * itself, and `lg:hidden` on the sheet's *content* leaves that overlay in
 * place — invisible, covering the whole desktop layout, and swallowing every
 * click on the map beneath it.
 *
 * Reading the viewport during render is safe here only because nothing is
 * selected on first paint, so neither variant renders until the visitor has
 * clicked something.
 */
export function PlacePanel({
  place,
  order,
  utcOffsetMinutes,
  onClose,
}: PlacePanelProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  if (place === null) return null;

  if (!isDesktop) {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {/*
          `dark` is repeated here on purpose. The trip view scopes the dark
          theme to its own wrapper, and this sheet renders through a portal to
          document.body — outside that wrapper, where the theme's custom
          properties do not reach. Without it the sheet comes up white on a
          black page. Any other portalled surface on this screen needs the same.
        */}
        <SheetContent
          side="bottom"
          className="dark max-h-[85dvh] overflow-y-auto"
        >
          <SheetHeader className="pb-2">
            <SheetTitle asChild>
              <div>
                <PanelHeading place={place} order={order} />
              </div>
            </SheetTitle>
            <SheetDescription className="sr-only">
              Details and photographs for {place.name}
            </SheetDescription>
          </SheetHeader>

          <div className="px-4 pb-6">
            <PlaceDetail place={place} utcOffsetMinutes={utcOffsetMinutes} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={`About ${place.name}`}
      className="absolute inset-y-4 left-4 z-10 flex w-[21rem] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/60 p-4">
        <PanelHeading place={place} order={order} />
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close place details"
          className="-mr-1 -mt-1 size-7 shrink-0"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <PlaceDetail place={place} utcOffsetMinutes={utcOffsetMinutes} />
      </div>
    </aside>
  );
}
