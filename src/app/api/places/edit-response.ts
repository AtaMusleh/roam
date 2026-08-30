/**
 * Shared plumbing for the place-editing routes.
 *
 * Four handlers that all need the same three things: refuse when editing is
 * off, turn a `PlaceEditError` into the status it carries, and answer with the
 * place as it now stands.
 */

import { NextResponse } from "next/server";

import { canEdit } from "@/lib/auth";
import { PlaceEditError } from "@/lib/place-edits";
import { prisma } from "@/lib/prisma";
import { clearTripsIndexCache } from "@/lib/queries";

/**
 * Drops the cached trips index after a successful edit.
 *
 * Every one of the four operations changes something the index shows: rename
 * changes the cover's place name, merge and delete change the place count, and
 * split changes both. Without this the index would keep serving the old
 * numbers for up to five minutes after a correction — long enough for the
 * owner to reasonably conclude the edit had not worked.
 *
 * Dropped outright rather than refreshed in the background: the person who
 * triggered this is the one who just made the correction and is about to go
 * and look at it, so their next request should wait for fresh numbers. It is
 * one request against a two-query read.
 */
export function invalidateTripsIndex(): void {
  clearTripsIndexCache();
}

/**
 * Returns a 403 response when the caller may not edit, or `null` to carry on.
 *
 * Every mutating handler calls this first, and it is the only place that
 * decides. The session cookie is verified here on the server on every request
 * — the panel hiding its controls for a signed-out visitor is a courtesy, not
 * the enforcement, and anyone who finds these endpoints directly gets the same
 * flat refusal.
 */
export async function editGuard(): Promise<NextResponse | null> {
  if (await canEdit()) return null;

  return NextResponse.json(
    {
      error: "Editing requires the owner to be signed in",
      hint: "Sign in at /admin.",
    },
    { status: 403 },
  );
}

export function handleEditError(error: unknown): NextResponse {
  if (error instanceof PlaceEditError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 },
  );
}

/** The place after an edit, so the caller can see what it became. */
export async function editedPlaceResponse(placeId: string): Promise<NextResponse> {
  const place = await prisma.place.findUnique({
    where: { id: placeId },
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      photoCount: true,
      visits: {
        orderBy: { arrivedAt: "asc" },
        select: { id: true, arrivedAt: true, departedAt: true, sequence: true },
      },
    },
  });

  if (!place) {
    return NextResponse.json({ error: "Place not found after edit" }, { status: 500 });
  }

  return NextResponse.json({ place });
}
