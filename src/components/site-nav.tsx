import Link from "next/link";
import { ChevronLeft, LogOut, Upload } from "lucide-react";

import { signOut } from "@/app/admin/actions";
import { SITE_NAME } from "@/lib/site";
import { cn } from "@/lib/utils";

interface SiteNavProps {
  /**
   * The page to go back to, if there is one above this. Omitted on `/trips`
   * itself, where the wordmark alone is enough.
   */
  back?: { href: string; label: string };
  /**
   * Whether the owner is signed in, decided by the page that renders this.
   *
   * Passed in rather than read here so the decision to become dynamic — which
   * reading a cookie forces — belongs to each route rather than being imposed
   * on every route that happens to want a navigation bar.
   */
  signedIn?: boolean;
  className?: string;
}

/**
 * The thin bar across the top of every screen below the home page.
 *
 * It exists because a trip page was previously a dead end: arriving at
 * `/rome-may-2026` from a link left no way to the other trips or back to the
 * home page short of editing the address bar. Two links is all it takes to fix
 * that, and two links is all this is — a server component with no state, so it
 * costs nothing on the client.
 *
 * Deliberately quiet. The photographs are the point of these screens, and a
 * navigation bar competing with them would be the wrong trade.
 */
export function SiteNav({ back, signedIn = false, className }: SiteNavProps) {
  return (
    <nav
      aria-label="Site"
      className={cn(
        "flex shrink-0 items-center gap-4 border-b border-border/60 px-4 py-2.5 sm:px-6",
        className,
      )}
    >
      <Link
        href="/"
        className="rounded text-sm font-semibold tracking-tight transition-colors hover:text-roam-accent focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        {SITE_NAME}
      </Link>

      {back !== undefined && (
        <>
          <span aria-hidden className="text-border">
            /
          </span>

          <Link
            href={back.href}
            className="group inline-flex items-center gap-1 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            <ChevronLeft
              aria-hidden
              className="size-4 transition-transform group-hover:-translate-x-0.5"
            />
            {back.label}
          </Link>
        </>
      )}

      {/* Only for the owner. Everyone else has nothing to import to, so the
          link would be a door with no handle. */}
      {signedIn && (
        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          <Link
            href="/upload"
            className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-roam-accent focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            <Upload aria-hidden className="size-4" />
            Upload
          </Link>

          {/* The indicator is a link to /admin rather than a bare label: it is
              the only thing on screen saying the session exists, so it should
              also be the way to the page that says more about it. */}
          <Link
            href="/admin"
            className="rounded-full border border-roam-accent/40 bg-roam-accent/10 px-2.5 py-0.5 text-xs font-medium text-roam-accent transition-colors hover:bg-roam-accent/20 focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            Owner
          </Link>

          {/*
            A form rather than a link, because signing out changes something.
            A GET that mutates is a link any crawler, prefetcher or
            link-preview can follow — and this app prefetches its own nav — so
            the session would end without anyone having asked.
          */}
          <form action={signOut}>
            <button
              type="submit"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              <LogOut aria-hidden className="size-4" />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </button>
          </form>
        </div>
      )}
    </nav>
  );
}
