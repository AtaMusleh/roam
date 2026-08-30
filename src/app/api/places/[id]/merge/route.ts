/**
 * POST /api/places/[id]/merge
 *
 * Folds the place named in the body into this one, keeping both sets of
 * visits. `{ "otherPlaceId": "..." }`
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { mergePlaces } from "@/lib/place-edits";
import {
  editGuard,
  editedPlaceResponse,
  handleEditError,
  invalidateTripsIndex,
} from "../../edit-response";

export const runtime = "nodejs";

const body = z.object({ otherPlaceId: z.string().min(1) }).strict();

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/places/[id]/merge">,
): Promise<NextResponse> {
  const refused = await editGuard();
  if (refused) return refused;

  const { id } = await context.params;

  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body with an `otherPlaceId`" },
      { status: 400 },
    );
  }

  try {
    await mergePlaces(id, parsed.otherPlaceId);
  } catch (error) {
    return handleEditError(error);
  }

  invalidateTripsIndex();
  return editedPlaceResponse(id);
}
