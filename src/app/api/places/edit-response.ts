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
