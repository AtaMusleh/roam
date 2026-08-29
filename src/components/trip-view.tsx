"use client";

import { useCallback, useMemo, useState } from "react";

import { TripMap } from "@/components/map/trip-map";
import type { MapPlace } from "@/components/map/trip-map";
import { LightboxProvider } from "@/components/photo-lightbox";
import { PlacePanel } from "@/components/place/place-panel";
import { Timeline } from "@/components/timeline/timeline";
import type { TimelineDay } from "@/components/timeline/types";
import type { TripDetail } from "@/lib/queries";

interface TripViewProps {
  trip: TripDetail;
  days: readonly TimelineDay[];
  /** Whether this deployment permits manual corrections. */
  canEdit: boolean;
}

/**
 * The trip screen, and the one place selection lives.
 *
 * The page above is a server component; this is the smallest wrapper that has
 * to be a client one, because the map, the timeline and the panel all need to
 * agree on which place is selected and which is under the pointer. Holding
 * that state here and passing it down means there is a single answer at any
 * moment: click a marker and the timeline row highlights, hover a row and the
 * marker grows, and nothing has to synchronise with anything.
 */
export function TripView({ trip, days, canEdit }: TripViewProps) {
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [hoveredPlaceId, setHoveredPlaceId] = useState<string | null>(null);

  // `places` is already chronological, so the index is the visiting order.
  const mapPlaces = useMemo<MapPlace[]>(
    () =>
      trip.places.map((place, index) => ({
        id: place.id,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        order: index + 1,
        photoCount: place.visits.reduce(
          (total, visit) => total + visit.photos.length,
          0,
        ),
      })),
    [trip.places],
  );

  const selectedPlace =
    trip.places.find((place) => place.id === selectedPlaceId) ?? null;
  const selectedOrder =
    selectedPlace === null
      ? null
      : trip.places.indexOf(selectedPlace) + 1;

  // Selecting the place that is already selected closes the panel, which is
  // what a second click on the same marker should mean.
  const handleSelect = useCallback((placeId: string) => {
    setSelectedPlaceId((current) => (current === placeId ? null : placeId));
  }, []);

  const handleClose = useCallback(() => {
    setSelectedPlaceId(null);
  }, []);

  return (
    // The lightbox lives above both panes: the timeline strips and the place
    // panel open the same overlay, and only ever one at a time.
    <LightboxProvider>
      <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <div className="relative h-[55dvh] shrink-0 border-b border-border/60 lg:h-auto lg:min-h-0 lg:flex-1 lg:border-b-0">
          <TripMap
            places={mapPlaces}
            selectedPlaceId={selectedPlaceId}
            hoveredPlaceId={hoveredPlaceId}
            onSelectPlace={handleSelect}
          />

          <PlacePanel
            place={selectedPlace}
            order={selectedOrder}
            places={trip.places}
            utcOffsetMinutes={trip.utcOffsetMinutes}
            canEdit={canEdit}
            onClose={handleClose}
          />
        </div>

        <aside className="lg:w-[24rem] lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-border/60">
          <Timeline
            days={days}
            utcOffsetMinutes={trip.utcOffsetMinutes}
            selectedPlaceId={selectedPlaceId}
            hoveredPlaceId={hoveredPlaceId}
            onSelectPlace={handleSelect}
            onHoverPlace={setHoveredPlaceId}
          />
        </aside>
      </div>
    </LightboxProvider>
  );
}
