/**
 * PATCH  /api/places/[id]   — rename
 * DELETE /api/places/[id]   — remove, returning its photographs to unassigned
 *
 * Both are gated on `ALLOW_EDITS`, like every other mutation. See
 * `src/lib/place-edits.ts` for why these operations exist at all.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { deletePlace, renamePlace } from "@/lib/place-edits";
import { editGuard, handleEditError, editedPlaceResponse } from "../edit-response";

export const runtime = "nodejs";

const renameBody = z.object({ name: z.string().min(1).max(200) }).strict();

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/places/[id]">,
): Promise<NextResponse> {
  const refused = editGuard();
  if (refused) return refused;

  const { id } = await context.params;

  let parsed: z.infer<typeof renameBody>;
  try {
    parsed = renameBody.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body with a `name`" },
      { status: 400 },
    );
  }

  try {
    await renamePlace(id, parsed.name);
  } catch (error) {
    return handleEditError(error);
  }

  return editedPlaceResponse(id);
}

export async function DELETE(
  _request: NextRequest,
  context: RouteContext<"/api/places/[id]">,
): Promise<NextResponse> {
  const refused = editGuard();
  if (refused) return refused;

  const { id } = await context.params;

  try {
    await deletePlace(id);
  } catch (error) {
    return handleEditError(error);
  }

  return NextResponse.json({ deleted: id });
}
