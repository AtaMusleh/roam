import { Fragment } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { BlurhashCanvas } from "@/components/blurhash-canvas";
import {
  ClusterDiagram,
  ExifDiagram,
  NameDiagram,
  TimelineDiagram,
} from "@/components/home/diagrams";
import { HeroHeading } from "@/components/home/hero-heading";
import { HeroParallax } from "@/components/home/hero-parallax";
import { CountUp } from "@/components/motion/count-up";
import { Reveal, RevealGroup } from "@/components/motion/reveal";
import { SmoothScroll } from "@/components/motion/smooth-scroll";
import { STAGGER } from "@/lib/motion";
import { getShowcase } from "@/lib/queries";
import { GITHUB_URL, OSM_COPYRIGHT, SITE_NAME, SITE_TAGLINE } from "@/lib/site";
import { UNSPLASH_HOME, unsplashVariant } from "@/lib/unsplash";

export const metadata: Metadata = {
  title: "Roam — a map of where your photographs were taken",
  description: SITE_TAGLINE,
};

/**
 * The page is built from live data, so it should not be frozen at build time.
 * An hour is generous for a demo whose contents change when someone reseeds or
 * corrects a place, and it keeps the page a static asset the rest of the time.
 */
export const revalidate = 3600;

/** Width to request for the hero. Wide enough for a full-bleed backdrop. */
const HERO_WIDTH = 2560;

interface Step {
  title: string;
  body: string;
  diagram: React.ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Read the coordinates",
    body: "Most cameras write a latitude and longitude into every photograph they take. Roam reads them straight out of the file, along with the moment the shutter opened.",
    diagram: <ExifDiagram />,
  },
  {
    title: "Cluster them into places",
    body: "A morning at one museum is forty photographs a few metres apart. Density-based clustering finds those crowds and draws a boundary around each one, leaving the shots taken walking between them outside.",
    diagram: <ClusterDiagram />,
  },
  {
    title: "Name them from the map",
    body: "Each cluster's centre is looked up against OpenStreetMap. Where a named site encloses it, that is the name — the Colosseum rather than the street the Colosseum stands on.",
    diagram: <NameDiagram />,
  },
  {
    title: "Order them into a journey",
    body: "The places are laid end to end in the order you reached them, split into days, and drawn on a map as a route — which is the shape a trip actually has.",
    diagram: <TimelineDiagram />,
  },
];

interface Decision {
  title: string;
  body: string;
}

const DECISIONS: Decision[] = [
  {
    title: "Distance in metres, not degrees",
    body: "Clustering uses great-circle distance, so a radius means the same thing everywhere. Measuring in degrees would make that radius an ellipse on the ground — at Rome's latitude, 34% wider east to west than north to south — and the further from the equator, the worse it gets.",
  },
  {
    title: "One place, two visits",
    body: "The same café on Monday and Thursday sits at one set of coordinates, so clustering alone cannot tell the mornings apart. Each cluster is cut back along the time axis wherever a long gap appears, which is what makes a return visit a return rather than one implausible nine-hour stay.",
  },
  {
    title: "Photographs that arrived without GPS",
    body: "About one in seven has no position — location services off, a screenshot, an app that stripped the metadata. Their place is inferred from the photographs either side of them in time, and only when those are close enough together for the answer to mean anything. Past that, the photograph stays unplaced rather than being given a plausible guess.",
  },
];

export default async function Home() {
  const showcase = await getShowcase();

  const hero = showcase?.hero ?? null;
  const heroSrc =
    hero === null ? null : unsplashVariant(hero.url, HERO_WIDTH, hero.width);

  return (
    // `dark` is scoped here as it is on the trip page, so the two screens agree
    // and neither depends on a document-level theme.
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <SmoothScroll />

      {/* --- hero ----------------------------------------------------------- */}

      <header className="relative isolate flex min-h-[85dvh] flex-col justify-end overflow-hidden">
        {hero !== null && heroSrc !== null && (
          // The photograph and its blurhash move together, so the placeholder
          // stays behind the image it is standing in for rather than sliding
          // out from under it.
          <HeroParallax className="absolute inset-x-0 top-0 -z-20">
            {hero.blurhash !== null && (
              <BlurhashCanvas hash={hero.blurhash} className="-z-10" />
            )}
            <Image
              src={heroSrc}
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
          </HeroParallax>
        )}

        {/*
          Two gradients rather than a flat scrim: the text sits at the bottom
          and needs contrast there, while the top of the photograph can stay
          bright. A single overlay dark enough for the text would flatten it.
        */}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/70 to-background/20" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-background/60 to-transparent" />

        <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-24 sm:pb-24">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-roam-accent">
            {SITE_NAME}
          </p>

          <HeroHeading
            text="A map of where your photographs were taken."
            className="max-w-3xl text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl"
          />

          <Reveal as="p" delay={0.2} className="mt-5 max-w-2xl">
            <span className="block text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
              {SITE_TAGLINE}
            </span>
          </Reveal>

          {showcase !== null && (
            <>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
                <Link
                  href="/trips"
                  className="group inline-flex items-center justify-center gap-2 rounded-full bg-roam-accent px-6 py-3 text-sm font-semibold text-roam-accent-foreground transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                >
                  {showcase.tripCount === 1
                    ? "See the trip"
                    : `See all ${showcase.tripCount} trips`}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>

                {/* A shortcut straight into the trip the rest of this was built
                    against, for a reader who would rather not choose first. */}
                {showcase.featured !== null && (
                  <Link
                    href={`/${showcase.featured.slug}`}
                    className="text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-roam-accent focus-visible:ring-2 focus-visible:ring-roam-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                  >
                    or open {showcase.featured.name} directly
                  </Link>
                )}
              </div>

              <p className="mt-5 text-sm text-muted-foreground tabular-nums">
                <CountUp value={showcase.totals.photoCount} /> photographs
                &middot; <CountUp value={showcase.totals.placeCount} /> places
                &middot; <CountUp value={showcase.totals.dayCount} /> days
                &middot; <CountUp value={showcase.tripCount} />{" "}
                {showcase.tripCount === 1 ? "trip" : "trips"}
              </p>
            </>
          )}
        </div>

        {hero?.photographerName != null && (
          <p className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1.5 text-[11px] text-white/80">
            {hero.placeName !== null && (
              <span className="text-white/60">{hero.placeName} &middot; </span>
            )}
            Photo by{" "}
            <a
              href={hero.photographerUrl ?? UNSPLASH_HOME}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-white"
            >
              {hero.photographerName}
            </a>{" "}
            on{" "}
            <a
              href={UNSPLASH_HOME}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-white"
            >
              Unsplash
            </a>
          </p>
        )}
      </header>

      {/* --- how it works --------------------------------------------------- */}

      <section className="border-t border-border/60 py-16 sm:py-24">
        <div className="mx-auto w-full max-w-5xl px-6">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            How it works
          </h2>

          {/* Each step and its diagram arrive together, one after another, so
              the four read as a sequence — which is what they are. */}
          <RevealGroup
            as="ol"
            itemAs="li"
            className="mt-8 grid gap-10 sm:grid-cols-2 lg:grid-cols-4"
            itemClassName="flex flex-col gap-3"
            stagger={STAGGER.loose}
          >
            {STEPS.map((step, index) => (
              <Fragment key={step.title}>
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  {step.diagram}
                </div>

                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold tabular-nums text-roam-accent">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="text-sm font-semibold">{step.title}</h3>
                </div>

                <p className="text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </Fragment>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* --- decisions ------------------------------------------------------ */}

      <section className="border-t border-border/60 py-16 sm:py-24">
        <div className="mx-auto w-full max-w-5xl px-6">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Decisions worth knowing about
          </h2>

          <RevealGroup
            className="mt-8 grid gap-8 lg:grid-cols-3"
            itemClassName="border-t border-roam-accent/40 pt-4"
            stagger={STAGGER.loose}
          >
            {DECISIONS.map((decision) => (
              <Fragment key={decision.title}>
                <h3 className="text-sm font-semibold">{decision.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {decision.body}
                </p>
              </Fragment>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* --- footer --------------------------------------------------------- */}

      <footer className="mt-auto border-t border-border/60 py-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-foreground underline underline-offset-4 hover:text-roam-accent"
          >
            Source on GitHub
          </a>

          <p className="text-pretty">
            Photographs from{" "}
            <a
              href={UNSPLASH_HOME}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Unsplash
            </a>
            , each credited to its photographer. Place names and map data{" "}
            <a
              href={OSM_COPYRIGHT}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4 hover:text-foreground"
            >
              © OpenStreetMap contributors
            </a>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}
