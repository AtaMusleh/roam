"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SITE_NAME } from "@/lib/site";

/**
 * What `/trips` shows when loading it fails.
 *
 * The framework's own screen says "This page couldn't load" and offers nothing
 * else — no way back, no way to try again, and no indication of whether the
 * problem is worth reporting. That is the wrong last impression for a database
 * hiccup that a retry usually clears.
 *
 * `reset` re-runs the segment without a full page load, which is the right
 * first thing to try: the usual cause here is a cold database connection that
 * timed out, and the second attempt finds it awake.
 */
export default function TripsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is what ties this to the server log; the message itself is
    // redacted in production, so without printing it there is no thread to
    // pull on from a bug report.
    console.error("The trips index failed to load:", error);
  }, [error]);

  return (
    <div className="dark flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md rounded-lg border border-border/60 bg-card p-6 sm:p-8">
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden className="size-5 text-amber-400" />
          <h1 className="text-lg font-semibold tracking-tight">
            The trips didn&apos;t load
          </h1>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Something went wrong fetching the list. This is usually a database
          connection waking up rather than anything being broken, and trying
          again is normally enough.
        </p>

        {error.digest !== undefined && (
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={reset} className="sm:flex-1">
            <RotateCw aria-hidden className="size-4" />
            Try again
          </Button>

          <Button asChild variant="outline" className="sm:flex-1">
            <Link href="/">Back to {SITE_NAME}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
