"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileImage,
  Hammer,
  ImageUp,
  Trash2,
  TriangleAlert,
  UploadCloud,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { TripOption } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * One file the owner has chosen, plus the preview made for it.
 *
 * `previewUrl` is an object URL, which is a reference into this document that
 * has to be released by hand — the browser will not collect the underlying blob
 * while one is outstanding. Every path that drops a file revokes it.
 */
interface Selected {
  /** Stable across re-renders, unlike anything derivable from the File. */
  id: string;
  file: File;
  previewUrl: string;
}

/** What the submit button has produced so far. */
type Outcome = "idle" | "refused";

const ACCEPTED = "image/jpeg,image/png,image/heic,image/heif,image/webp,image/avif";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadWorkbench({ trips }: { trips: TripOption[] }) {
  const [files, setFiles] = useState<Selected[]>([]);
  const [tripId, setTripId] = useState<string>(trips[0]?.id ?? "");
  const [dragging, setDragging] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("idle");

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Depth counter for drag events.
   *
   * `dragleave` fires when the pointer crosses into a *child* of the drop zone,
   * so clearing the highlight on the first one makes the zone flicker as the
   * pointer moves over the text inside it. Counting enter and leave against
   * each other is the standard fix.
   */
  const dragDepth = useRef(0);

  // Release every preview when the page goes away. Selecting and discarding a
  // few hundred photographs over one session would otherwise pin all of them
  // in memory until a reload.
  useEffect(() => {
    return () => {
      setFiles((current) => {
        for (const entry of current) URL.revokeObjectURL(entry.previewUrl);
        return [];
      });
    };
  }, []);

  const addFiles = useCallback((incoming: FileList | null): void => {
    if (incoming === null) return;

    const images = Array.from(incoming).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) return;

    setOutcome("idle");
    setFiles((current) => {
      // Name and size together are enough to catch the same folder dropped
      // twice, which is the mistake worth catching.
      const seen = new Set(
        current.map((entry) => `${entry.file.name}:${String(entry.file.size)}`),
      );

      const added: Selected[] = [];
      for (const file of images) {
        const key = `${file.name}:${String(file.size)}`;
        if (seen.has(key)) continue;

        seen.add(key);
        added.push({
          id: `${key}:${String(file.lastModified)}:${String(added.length)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }

      return [...current, ...added];
    });
  }, []);

  const removeFile = useCallback((id: string): void => {
    setFiles((current) => {
      const going = current.find((entry) => entry.id === id);
      if (going) URL.revokeObjectURL(going.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }, []);

  const clearAll = useCallback((): void => {
    setFiles((current) => {
      for (const entry of current) URL.revokeObjectURL(entry.previewUrl);
      return [];
    });
    setOutcome("idle");
  }, []);

  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="space-y-6">
        {/* --- drop zone ---------------------------------------------------- */}

        <div
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            // Without this the browser navigates to the dropped file instead.
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          className={cn(
            "rounded-lg border-2 border-dashed p-10 text-center transition-colors",
            dragging
              ? "border-roam-accent bg-roam-accent/10"
              : "border-border/60 bg-muted/10",
          )}
        >
          <UploadCloud
            aria-hidden
            className={cn(
              "mx-auto size-8 transition-colors",
              dragging ? "text-roam-accent" : "text-muted-foreground",
            )}
          />

          <p className="mt-4 text-sm font-medium">
            Drag photographs here, or choose them
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            JPEG, PNG, HEIC or WebP. The coordinates and timestamps are read out
            of the files themselves, so originals work better than anything a
            messaging app has already been through.
          </p>

          <Button
            type="button"
            variant="outline"
            className="mt-5"
            onClick={() => inputRef.current?.click()}
          >
            <ImageUp aria-hidden className="size-4" />
            Choose files
          </Button>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED}
            className="sr-only"
            onChange={(event) => {
              addFiles(event.target.files);
              // Cleared so choosing the same file twice still fires a change.
              event.target.value = "";
            }}
          />
        </div>

        {/* --- chosen files ------------------------------------------------- */}

        {files.length > 0 && (
          <section aria-labelledby="chosen-heading" className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="chosen-heading" className="text-sm font-semibold">
                {files.length} {files.length === 1 ? "photograph" : "photographs"}
                <span className="ml-2 font-normal text-muted-foreground tabular-nums">
                  {formatBytes(totalBytes)}
                </span>
              </h2>

              <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
                Clear all
              </Button>
            </div>

            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {files.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 p-2.5">
                  {/* A plain <img>: the source is a blob URL for a file that
                      never reaches the server, so there is nothing for the
                      image optimiser to do with it. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={entry.previewUrl}
                    alt=""
                    className="size-12 shrink-0 rounded object-cover"
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.file.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {formatBytes(entry.file.size)}
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      removeFile(entry.id);
                    }}
                  >
                    <Trash2 aria-hidden className="size-4" />
                    <span className="sr-only">Remove {entry.file.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* --- destination and submit --------------------------------------- */}

        <div className="space-y-4 rounded-lg border border-border/60 p-5">
          <div className="space-y-2">
            <Label htmlFor="trip">Add to trip</Label>

            {trips.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No trips exist yet. Seed one with{" "}
                <code className="rounded bg-muted/40 px-1.5 py-0.5 text-xs">
                  npm run seed:all
                </code>
                .
              </p>
            ) : (
              <select
                id="trip"
                value={tripId}
                onChange={(event) => {
                  setTripId(event.target.value);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                {trips.map((trip) => (
                  <option key={trip.id} value={trip.id}>
                    {trip.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <Button
            type="button"
            className="w-full"
            disabled={files.length === 0 || tripId === ""}
            onClick={() => {
              setOutcome("refused");
            }}
          >
            <UploadCloud aria-hidden className="size-4" />
            Import {files.length > 0 ? `${String(files.length)} ` : ""}
            {files.length === 1 ? "photograph" : "photographs"}
          </Button>

          {outcome === "refused" && (
            <div
              role="status"
              className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4"
            >
              <TriangleAlert
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-amber-400"
              />
              <div className="space-y-1.5">
                <p className="text-sm font-semibold">Not yet implemented.</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Nothing was uploaded and nothing was changed. This page is the
                  interface for an import pipeline that has not been built —
                  everything up to this button works, and past it there is no
                  code yet. The panel beside it describes what will go there.
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Until then, trips are created by{" "}
                  <code className="rounded bg-muted/40 px-1.5 py-0.5 text-xs">
                    npm run seed:all
                  </code>{" "}
                  from the generated datasets.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <PipelinePanel />
    </div>
  );
}

interface Stage {
  title: string;
  body: string;
  /** What already exists that this stage would reuse. */
  reuses: string | null;
}

/**
 * What the button would do, if it did anything.
 *
 * Written as intent rather than as a promise. The value of an unbuilt page is
 * that it makes the shape of the missing work explicit — which parts are
 * genuinely new, and which are already sitting in the repository waiting for a
 * caller.
 */
const STAGES: Stage[] = [
  {
    title: "Read EXIF in the browser",
    body: "Latitude, longitude and the moment the shutter opened are parsed here, before anything is sent. A photograph with no coordinates can be reported immediately rather than after a slow upload, and the whole set can be checked against the chosen trip's dates.",
    reuses: "exifr, already a dependency",
  },
  {
    title: "Resize before upload",
    body: "A phone photograph is several megabytes and forty times the pixels any of these screens will show. Downscaling to a sensible long edge on a canvas first turns a folder of five hundred into an upload that finishes.",
    reuses: null,
  },
  {
    title: "Store on Cloudinary",
    body: "Uploaded straight from the browser with a signed request, so the images never pass through this server. Cloudinary returns the URL and dimensions; a blurhash is computed and stored alongside them, as the demo trips already carry.",
    reuses: "cloudinary and next-cloudinary, already configured",
  },
  {
    title: "Cluster it",
    body: "Exactly the same ingest the demo trips went through: DBSCAN over the coordinates, split into visits along the time axis, positions interpolated for photographs that arrived without GPS, and each place named from OpenStreetMap.",
    reuses: "ingestTrip, unchanged",
  },
];

function PipelinePanel() {
  return (
    <aside className="space-y-5 rounded-lg border border-border/60 bg-muted/10 p-5 lg:sticky lg:top-6">
      <div className="flex items-center gap-2">
        <Hammer aria-hidden className="size-4 text-roam-accent" />
        <h2 className="text-sm font-semibold">What this will do</h2>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        The interface is finished; the pipeline behind it is not. These are the
        four steps that go between the button and a browsable trip, in order.
      </p>

      <ol className="space-y-4">
        {STAGES.map((stage, index) => (
          <li key={stage.title} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-roam-accent/40 text-[10px] font-semibold tabular-nums text-roam-accent">
              {index + 1}
            </span>

            <div className="space-y-1">
              <h3 className="text-xs font-semibold">{stage.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {stage.body}
              </p>
              {stage.reuses !== null && (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
                  <FileImage aria-hidden className="size-3" />
                  Reuses {stage.reuses}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
