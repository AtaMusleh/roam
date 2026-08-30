import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteNav } from "@/components/site-nav";
import { isSignedIn } from "@/lib/auth";
import { getTripOptions } from "@/lib/queries";
import { SITE_NAME } from "@/lib/site";
import { UploadWorkbench } from "./upload-workbench";

export const metadata: Metadata = {
  title: `Import photographs · ${SITE_NAME}`,
  description: "Designed, not yet built.",
  robots: { index: false, follow: false },
};

/** Reads the session cookie, so it cannot be prerendered. */
export const dynamic = "force-dynamic";

export default async function UploadPage() {
  // Redirected rather than refused: a signed-out visitor here has either
  // guessed the address or let a session lapse, and the sign-in page is the
  // answer to both. Nothing on this page is secret, but an interface for
  // changing trips has no business being offered to someone who cannot.
  if (!(await isSignedIn())) redirect("/admin");

  const trips = await getTripOptions();

  return (
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <SiteNav back={{ href: "/trips", label: "All trips" }} signedIn />

      <header className="border-b border-border/60 px-6 py-10 sm:py-12">
        <div className="mx-auto w-full max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-roam-accent">
            Import
          </p>

          <h1 className="mt-3 text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
            Add photographs to a trip.
          </h1>

          {/* Said at the top, not discovered at the bottom. Somebody who spends
              ten minutes selecting four hundred photographs before finding out
              has been wasted, and the page has misled them to do it. */}
          <p className="mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
            <strong className="font-semibold text-foreground">
              This page does not work yet.
            </strong>{" "}
            Everything up to the import button is real — files are read, previewed
            and measured in your browser — but nothing is uploaded and no trip is
            changed. It exists to settle what the import should look like before
            the pipeline behind it is written.
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 sm:py-10">
        <UploadWorkbench trips={trips} />
      </main>

      <footer className="border-t border-border/60 py-8">
        <p className="mx-auto w-full max-w-5xl px-6 text-xs text-muted-foreground">
          Signed in as the owner.{" "}
          <Link
            href="/admin"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Sign out
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}
