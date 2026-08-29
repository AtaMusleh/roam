/**
 * POST /api/places/[id]/split
 *
 * Cuts the place in two at a chosen visit: that visit and every later one move
 * to a new place. `{ "dividingVisitId": "..." }`
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { splitPlace } from "@/lib/place-edits";
import { editGuard, handleEditError } from "../../edit-response";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const body = z.object({ dividingVisitId: z.string().min(1) }).strict();

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/places/[id]/split">,
): Promise<NextResponse> {
  const refused = editGuard();
  if (refused) return refused;

  const { id } = await context.params;

  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body with a `dividingVisitId`" },
      { status: 400 },
    );
  }

  let newPlaceId: string;
  try {
    ({ newPlaceId } = await splitPlace(id, parsed.dividingVisitId));
  } catch (error) {
    return handleEditError(error);
  }

  // Both halves, since the caller needs to know what the split produced.
  const places = await prisma.place.findMany({
    where: { id: { in: [id, newPlaceId] } },
    select: { id: true, name: true, lat: true, lng: true, photoCount: true },
  });

  return NextResponse.json({ places, newPlaceId });
}
