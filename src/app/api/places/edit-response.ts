/**
 * Shared plumbing for the place-editing routes.
 *
 * Four handlers that all need the same three things: refuse when editing is
 * off, turn a `PlaceEditError` into the status it carries, and answer with the
 * place as it now stands.
 */

import { NextResponse } from "next/server";

import { editsAllowed, PlaceEditError } from "@/lib/place-edits";
import { prisma } from "@/lib/prisma";

/**
 * Returns a 403 response when editing is disabled, or `null` to carry on.
 *
 * Every mutating handler calls this first. The public demo runs without
 * `ALLOW_EDITS`, so anyone who finds these endpoints gets a flat refusal
 * rather than a way to rearrange the trip everyone else is looking at.
 */
export function editGuard(): NextResponse | null {
  if (editsAllowed()) return null;

  return NextResponse.json(
    {
      error: "Editing is disabled on this deployment",
      hint: "Set ALLOW_EDITS=true to enable it locally.",
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
