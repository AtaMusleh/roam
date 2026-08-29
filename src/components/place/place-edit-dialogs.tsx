"use client";

import { Merge, Pencil, Scissors, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTripDay, formatTripTime } from "@/lib/format";
import type { TripPlace } from "@/lib/queries";
import { cn } from "@/lib/utils";

type EditKind = "rename" | "merge" | "split" | "delete";

interface PlaceEditDialogsProps {
  place: TripPlace;
  /** Every other place on the trip, for merging into. */
  otherPlaces: readonly TripPlace[];
  utcOffsetMinutes: number;
  /** Called after a delete, since the place being shown no longer exists. */
  onDeleted: () => void;
}

/**
 * `dark` is repeated on every dialog: they portal to document.body, outside the
 * element the trip view scopes the theme to.
 */
const DIALOG = "dark sm:max-w-md";

async function callApi(
  url: string,
  init: RequestInit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });

    if (response.ok) return { ok: true };

    const body: unknown = await response.json().catch(() => null);
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;

    return { ok: false, error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Request failed" };
  }
}

export function PlaceEditDialogs({
  place,
  otherPlaces,
  utcOffsetMinutes,
  onDeleted,
}: PlaceEditDialogsProps) {
  const router = useRouter();

  const [open, setOpen] = useState<EditKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(place.name);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [divideAt, setDivideAt] = useState<string | null>(null);

  const close = (): void => {
    setOpen(null);
    setError(null);
  };

  const run = async (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    after?: () => void,
  ): Promise<void> => {
    setBusy(true);
    setError(null);

    const result = await action();
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    close();
    after?.();
    // The trip is a server component; refreshing re-runs the query so the map,
    // the timeline and the panel all pick up the change at once.
    router.refresh();
  };

  // Splitting needs somewhere to split. A single-visit place has no dividing
  // line to choose, and merging needs something to merge with.
  const canSplit = place.visits.length > 1;
  const canMerge = otherPlaces.length > 0;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <EditButton icon={<Pencil className="size-3.5" />} label="Rename"
          onClick={() => {
            setName(place.name);
            setOpen("rename");
          }}
        />
        <EditButton icon={<Merge className="size-3.5" />} label="Merge"
          disabled={!canMerge}
          onClick={() => {
            setMergeInto(null);
            setOpen("merge");
          }}
        />
        <EditButton icon={<Scissors className="size-3.5" />} label="Split"
          disabled={!canSplit}
          title={canSplit ? undefined : "A place with one visit has nothing to split"}
          onClick={() => {
            setDivideAt(place.visits[1]?.id ?? null);
            setOpen("split");
          }}
        />
        <EditButton icon={<Trash2 className="size-3.5" />} label="Delete"
          destructive
          onClick={() => {
            setOpen("delete");
          }}
        />
      </div>

      {/* --- rename ---------------------------------------------------------- */}

      <Dialog open={open === "rename"} onOpenChange={(next) => !next && close()}>
        <DialogContent className={DIALOG}>
          <DialogHeader>
            <DialogTitle>Rename this place</DialogTitle>
            <DialogDescription>
              Clustering names a place after whatever OpenStreetMap has at its
              centre, which is not always what you would call it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="place-name">Name</Label>
            <Input
              id="place-name"
              value={name}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>

          <EditError error={error} />

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || name.trim().length === 0 || name.trim() === place.name}
              onClick={() => {
                void run(() =>
                  callApi(`/api/places/${place.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ name: name.trim() }),
                  }),
                );
              }}
            >
              {busy ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- merge ----------------------------------------------------------- */}

      <Dialog open={open === "merge"} onOpenChange={(next) => !next && close()}>
        <DialogContent className={DIALOG}>
          <DialogHeader>
            <DialogTitle>Merge another place into this one</DialogTitle>
            <DialogDescription>
              Both sets of visits are kept — two mornings at the same café stay
              two mornings. The other place disappears.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {otherPlaces.map((other) => (
              <button
                key={other.id}
                type="button"
                onClick={() => {
                  setMergeInto(other.id);
                }}
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm",
                  mergeInto === other.id
                    ? "border-roam-accent bg-muted"
                    : "border-transparent hover:bg-muted/50",
                )}
              >
                <span className="truncate">{other.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {other.visits.length} visit{other.visits.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>

          <EditError error={error} />

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || mergeInto === null}
              onClick={() => {
                if (mergeInto === null) return;
                void run(() =>
                  callApi(`/api/places/${place.id}/merge`, {
                    method: "POST",
                    body: JSON.stringify({ otherPlaceId: mergeInto }),
                  }),
                );
              }}
            >
              {busy ? "Merging..." : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- split ----------------------------------------------------------- */}

      <Dialog open={open === "split"} onOpenChange={(next) => !next && close()}>
        <DialogContent className={DIALOG}>
          <DialogHeader>
            <DialogTitle>Split this place in two</DialogTitle>
            <DialogDescription>
              Choose the visit where the second place begins. It and everything
              after it move across; everything before stays here.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {place.visits.map((visit, index) => (
              <button
                key={visit.id}
                type="button"
                disabled={index === 0}
                onClick={() => {
                  setDivideAt(visit.id);
                }}
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  divideAt === visit.id
                    ? "border-roam-accent bg-muted"
                    : "border-transparent enabled:hover:bg-muted/50",
                )}
              >
                <span>{formatTripDay(visit.arrivedAt, utcOffsetMinutes)}</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatTripTime(visit.arrivedAt, utcOffsetMinutes)}
                  {index === 0 ? " — stays" : ""}
                </span>
              </button>
            ))}
          </div>

          <EditError error={error} />

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || divideAt === null}
              onClick={() => {
                if (divideAt === null) return;
                void run(() =>
                  callApi(`/api/places/${place.id}/split`, {
                    method: "POST",
                    body: JSON.stringify({ dividingVisitId: divideAt }),
                  }),
                );
              }}
            >
              {busy ? "Splitting..." : "Split"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- delete ---------------------------------------------------------- */}

      <Dialog open={open === "delete"} onOpenChange={(next) => !next && close()}>
        <DialogContent className={DIALOG}>
          <DialogHeader>
            <DialogTitle>Delete {place.name}?</DialogTitle>
            <DialogDescription>
              Its {place.visits.reduce((n, visit) => n + visit.photos.length, 0)}{" "}
              photographs stay on the trip and go back to being unassigned. Only
              the grouping is removed.
            </DialogDescription>
          </DialogHeader>

          <EditError error={error} />

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void run(
                  () => callApi(`/api/places/${place.id}`, { method: "DELETE" }),
                  onDeleted,
                );
              }}
            >
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditButton({
  icon,
  label,
  onClick,
  disabled,
  destructive,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        destructive
          ? "text-destructive enabled:hover:bg-destructive/10"
          : "text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:outline-none",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function EditError({ error }: { error: string | null }) {
  if (error === null) return null;

  return (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  );
}
