/**
 * POST /api/trips/[id]/cluster
 *
 * Re-runs clustering for a trip and returns the places and visits it produced.
 * Accepts optional DBSCAN parameters in the body so the clustering can be
 * retuned from the UI without a deploy:
 *
 *   { "epsilonMeters": 40, "minPoints": 5 }
 *
 * Ingest is idempotent, so calling this repeatedly replaces the trip's
 * clustering each time rather than accumulating duplicates.
 *
 * NOTE: this endpoint is unauthenticated, because the project has no auth yet.
 * It rewrites a trip's places and visits, so it must not ship to production as
 * it stands — whoever adds auth needs to gate this on ownership of the trip.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ingestTrip } from "@/lib/ingest";
import { prisma } from "@/lib/prisma";

// `pg` is a Node driver: this cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * A cold geocode cache costs one second per place, so a first clustering of a
 * twelve-place trip takes upwards of fifteen seconds. Later runs read the
 * cache and return promptly.
 */
export const maxDuration = 60;

const requestBody = z
  .object({
    epsilonMeters: z.number().positive().max(10_000).optional(),
    minPoints: z.number().int().min(1).max(100).optional(),
    visitGapMinutes: z.number().positive().max(10_080).optional(),
    maxInterpolationGapMinutes: z.number().positive().max(10_080).optional(),
    geocode: z.boolean().optional(),
    forceGeocode: z.boolean().optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/trips/[id]/cluster">,
): Promise<NextResponse> {
  const { id } = await context.params;

  // An empty body is the common case — "recluster with the defaults" — so it
  // has to be accepted rather than treated as malformed JSON.
  let raw: unknown = {};
  const text = await request.text();

  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Request body is not valid JSON" },
        { status: 400 },
      );
    }
  }

  const parsed = requestBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const trip = await prisma.trip.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!trip) {
    return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  }

  const result = await ingestTrip(trip.id, parsed.data);

  const visitsByPlace = new Map<string, typeof result.visits>();
  for (const visit of result.visits) {
    visitsByPlace.set(visit.placeId, [
      ...(visitsByPlace.get(visit.placeId) ?? []),
      visit,
    ]);
  }

  return NextResponse.json({
    tripId: result.tripId,
    stats: result.stats,
    places: result.places.map((place) => ({
      id: place.id,
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      photoCount: place.photoCount,
      visits: (visitsByPlace.get(place.id) ?? []).map((visit) => ({
        id: visit.id,
        arrivedAt: visit.arrivedAt,
        departedAt: visit.departedAt,
        sequence: visit.sequence,
      })),
    })),
    visits: result.visits.map((visit) => ({
      id: visit.id,
      placeId: visit.placeId,
      arrivedAt: visit.arrivedAt,
      departedAt: visit.departedAt,
      sequence: visit.sequence,
    })),
  });
}
