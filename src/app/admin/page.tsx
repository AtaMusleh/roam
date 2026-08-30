import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, KeyRound, ShieldCheck, TriangleAlert, Upload } from "lucide-react";

import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { SIGN_IN_ATTEMPT_LIMIT, SIGN_IN_WINDOW_MS } from "@/lib/attempt-limit";
import {
  adminConfig,
  editsForcedOpen,
  isSignedIn,
  sessionExpiresAt,
} from "@/lib/auth";
import { SITE_NAME } from "@/lib/site";
import { signOut } from "./actions";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: `Admin · ${SITE_NAME}`,
  description: "Sign in to correct places and import photographs.",
  // A sign-in page has nothing worth indexing, and a search result pointing at
  // one is only ever useful to somebody looking for a door to try.
  robots: { index: false, follow: false },
};

const WINDOW_MINUTES = Math.round(SIGN_IN_WINDOW_MS / 60000);

export default async function AdminPage() {
  const signedIn = await isSignedIn();
  const expiresAt = await sessionExpiresAt();
  const config = adminConfig();
  const devOverride = editsForcedOpen();

  return (
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <SiteNav signedIn={signedIn} />

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
        <div className="rounded-lg border border-border/60 bg-card p-6 sm:p-8">
          {signedIn ? (
            <SignedIn expiresAt={expiresAt} />
          ) : (
            <SignedOut problem={config.problem} />
          )}
        </div>

        {devOverride && (
          <p className="mt-4 rounded-md border border-roam-accent/40 bg-roam-accent/10 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <strong className="font-semibold text-foreground">
              ALLOW_EDITS is on.
            </strong>{" "}
            Editing is unlocked without a password because this is a development
            build. The override is ignored in production.
          </p>
        )}
      </main>

      <footer className="border-t border-border/60 py-8">
        <p className="mx-auto w-full max-w-md px-6 text-xs text-muted-foreground">
          One password, one owner. Everyone else sees {SITE_NAME} read-only.
        </p>
      </footer>
    </div>
  );
}

function SignedIn({ expiresAt }: { expiresAt: Date | null }) {
  return (
    <>
      <div className="flex items-center gap-2 text-roam-accent">
        <ShieldCheck aria-hidden className="size-5" />
        <h1 className="text-lg font-semibold tracking-tight">Signed in</h1>
      </div>

      {/*
        The date, spelled out. Thirty days is long enough that "for thirty
        days" tells you nothing useful a fortnight in — the question a reader
        actually has is when they will next be asked for the password, and
        that has an answer.

        Rendered in UTC on purpose. The server formats this, and formatting a
        date in the server's local zone would show one thing to the person who
        deployed it and another to everyone else.
      */}
      {expiresAt !== null && (
        <p className="mt-3 text-sm leading-relaxed">
          This browser stays unlocked until{" "}
          <time
            dateTime={expiresAt.toISOString()}
            className="font-medium text-foreground"
          >
            {expiresAt.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </time>
          .
        </p>
      )}

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        The corrections panel is available on every trip — rename, merge, split,
        or delete a place that clustering got wrong.
      </p>

      <div className="mt-6 space-y-2">
        <Link
          href="/trips"
          className="group flex items-center justify-between rounded-md border border-border/60 px-4 py-3 text-sm font-medium transition-colors hover:border-roam-accent/60 focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:outline-none"
        >
          Browse trips
          <ArrowRight
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </Link>

        <Link
          href="/upload"
          className="group flex items-center justify-between rounded-md border border-border/60 px-4 py-3 text-sm font-medium transition-colors hover:border-roam-accent/60 focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:outline-none"
        >
          <span className="flex items-center gap-2">
            <Upload aria-hidden className="size-4 text-muted-foreground" />
            Import photographs
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            designed, not built
          </span>
        </Link>
      </div>

      <form action={signOut} className="mt-6 border-t border-border/60 pt-6">
        <Button type="submit" variant="outline" className="w-full">
          Sign out
        </Button>
      </form>
    </>
  );
}

function SignedOut({ problem }: { problem: string | null }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <KeyRound aria-hidden className="size-5 text-roam-accent" />
        <h1 className="text-lg font-semibold tracking-tight">Owner sign-in</h1>
      </div>

      <p className="mt-3 mb-6 text-sm leading-relaxed text-muted-foreground">
        {SITE_NAME} is public and read-only. Signing in unlocks the corrections
        panel and the import page for this browser, for thirty days.
      </p>

      {problem === null ? (
        <SignInForm />
      ) : (
        <p
          role="status"
          className="flex gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-sm leading-relaxed text-muted-foreground"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {problem} Until it is, there is no way to sign in — which is the
            correct behaviour for a deployment that has not been given a
            password, not a fault to work around.
          </span>
        </p>
      )}

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        {SIGN_IN_ATTEMPT_LIMIT} attempts every {WINDOW_MINUTES} minutes.
      </p>
    </>
  );
}
