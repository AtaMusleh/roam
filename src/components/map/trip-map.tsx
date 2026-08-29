"use client";

import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";

import { MAP_STYLE, ROAM_ACCENT } from "@/lib/theme";

import "mapbox-gl/dist/mapbox-gl.css";

export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Position in the journey, from 1. Shown inside the marker. */
  order: number;
  photoCount: number;
}

interface TripMapProps {
  places: readonly MapPlace[];
  selectedPlaceId: string | null;
  hoveredPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
}

const ROUTE_SOURCE_ID = "roam-route";
const ROUTE_LAYER_ID = "roam-route-line";

/** Marker diameters in pixels, for the least and most photographed place. */
const MARKER_MIN_PX = 30;
const MARKER_MAX_PX = 62;

const FIT_PADDING = 96;

/**
 * Half the width of the desktop detail panel, in pixels.
 *
 * Keep in step with the panel width in src/components/place/place-panel.tsx.
 */
const PANEL_OFFSET_PX = 176;

export function TripMap({
  places,
  selectedPlaceId,
  hoveredPlaceId,
  onSelectPlace,
}: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  /** The styled button inside each marker, keyed by place. */
  const elementsRef = useRef(new Map<string, HTMLElement>());

  /**
   * Props the map's own listeners need, held in refs.
   *
   * A marker's click handler is registered once, on a DOM node outside React's
   * tree, and then lives as long as the map does. Closing over `onSelectPlace`
   * directly would pin it to whichever render created the marker. Reading it
   * from a ref means the handler always calls the current one — and, crucially,
   * means neither prop belongs in the initialisation effect's dependencies.
   */
  const onSelectRef = useRef(onSelectPlace);

  useEffect(() => {
    onSelectRef.current = onSelectPlace;
  }, [onSelectPlace]);

  const [ready, setReady] = useState(false);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // --- the map itself -----------------------------------------------------
  //
  // Empty dependencies, deliberately and permanently. A Mapbox map is a WebGL
  // context, a network client and a pile of DOM; recreating one because a
  // parent re-rendered would drop the user's pan and zoom, leak the context,
  // and eventually exhaust the browser's supply of them. It is created once,
  // mutated through the effects below for the rest of its life, and destroyed
  // exactly once on unmount.

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || !token) return;

    // Captured now so the cleanup below closes over this exact Map, rather
    // than reading `.current` again after unmount.
    const markers = markersRef.current;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container,
      style: MAP_STYLE,
      center: [12.4922, 41.8902],
      zoom: 12,
      attributionControl: true,
      // The photographs are the subject; a tilted, rotatable map is fidgeting.
      pitchWithRotate: false,
      dragRotate: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      setReady(true);
    });

    mapRef.current = map;

    return () => {
      markers.forEach((marker) => {
        marker.remove();
      });
      markers.clear();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [token]);

  // --- markers and the route ----------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const markers = markersRef.current;
    const elements = elementsRef.current;

    const photoCounts = places.map((place) => place.photoCount);
    const busiest = Math.max(1, ...photoCounts);

    for (const place of places) {
      // Area, not diameter, tracks the photo count: a place with four times
      // the photographs should look four times the marker, and the eye reads
      // circles by area.
      const scale = Math.sqrt(place.photoCount / busiest);
      const size = Math.round(MARKER_MIN_PX + (MARKER_MAX_PX - MARKER_MIN_PX) * scale);

      // Two elements, not one. Mapbox positions a marker by writing an inline
      // `transform: translate(...)` onto the element it was handed, which
      // silently beats any transform a stylesheet puts on the same element —
      // so a `scale()` applied to it does nothing at all. The wrapper is
      // Mapbox's to move; the button inside it is ours to grow.
      const anchor = document.createElement("div");

      const element = document.createElement("button");
      element.type = "button";
      element.className = "roam-marker";
      element.style.setProperty("--marker-size", `${size}px`);
      element.textContent = String(place.order);
      element.setAttribute("aria-label", `${place.order}. ${place.name}`);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelectRef.current(place.id);
      });

      anchor.appendChild(element);
      elements.set(place.id, element);

      markers.set(
        place.id,
        new mapboxgl.Marker({ element: anchor })
          .setLngLat([place.lng, place.lat])
          .addTo(map),
      );
    }

    // The route: places joined in the order they were visited. Dashed, because
    // it is an inference about a journey rather than a recorded track.
    if (places.length >= 2) {
      const line: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: places.map((place) => [place.lng, place.lat]),
        },
      };

      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: line });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROAM_ACCENT,
          "line-width": 1.5,
          "line-opacity": 0.5,
          "line-dasharray": [2, 3],
        },
      });
    }

    if (places.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      for (const place of places) bounds.extend([place.lng, place.lat]);

      map.fitBounds(bounds, {
        padding: FIT_PADDING,
        // A trip to one place would otherwise zoom to the maximum.
        maxZoom: 15,
        duration: 0,
      });
    }

    return () => {
      markers.forEach((marker) => {
        marker.remove();
      });
      markers.clear();
      elements.clear();

      if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
      if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
    };
  }, [places, ready]);

  // --- selection and hover ------------------------------------------------
  //
  // Both are written straight onto the marker elements. They change often, and
  // pushing them through React would mean re-rendering the map component for
  // something only ever expressed as two attributes on a DOM node.

  useEffect(() => {
    if (!ready) return;

    const anySelected = selectedPlaceId !== null;

    elementsRef.current.forEach((element, placeId) => {
      const selected = placeId === selectedPlaceId;

      element.dataset["selected"] = String(selected);
      element.dataset["hovered"] = String(placeId === hoveredPlaceId);
      element.dataset["dimmed"] = String(anySelected && !selected);
    });
  }, [hoveredPlaceId, ready, selectedPlaceId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || selectedPlaceId === null) return;

    const place = places.find((candidate) => candidate.id === selectedPlaceId);
    if (!place) return;

    // On desktop the detail panel covers the map's left edge, so centring the
    // selected place would put it under the panel's right half. Nudging the
    // view puts it in the middle of what can actually be seen. The panel is
    // hidden below `lg`, where no offset is wanted.
    const panelIsOpen = window.matchMedia("(min-width: 1024px)").matches;

    map.easeTo({
      center: [place.lng, place.lat],
      zoom: Math.max(map.getZoom(), 15),
      offset: panelIsOpen ? [PANEL_OFFSET_PX, 0] : [0, 0],
      duration: 600,
    });
  }, [places, ready, selectedPlaceId]);

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/30 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          The map needs <code className="font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code>{" "}
          in your environment. The timeline below works without it.
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
