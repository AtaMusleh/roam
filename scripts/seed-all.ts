/**
 * Seeds every itinerary, one after another, in a single process.
 *
 *   npx tsx scripts/seed-all.ts
 *   npx tsx scripts/seed-all.ts --placeholder --no-geocode
 *
 * ## Why one process rather than a loop in the shell
 *
 * Place naming goes out to Nominatim and Overpass, both free public services
 * that ask for no more than one request a second. The limiter that enforces
 * that lives in module state, so it only holds within a single process. Seeding
 * four cities as four `tsx` invocations would give four independent limiters
 * talking over each other at four times the agreed rate — which is rude, and a
 * quick way to have the IP blocked. Running them in sequence here means one
 * limiter governs the whole run from beginning to end.
 *
 * Cities are seeded in order and independently: one failing does not stop the
 * rest, and the exit code reports whether any did.
 */

// Must stay first: it populates DATABASE_URL before the Prisma client below is
// imported, and that client throws at import time without it.
import "./load-env";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { prisma } from "../src/lib/prisma";
import { availableCities } from "./generate-trip";
import { seedCity } from "./seed-demo-trip";
import type { SeedCitySummary } from "./seed-demo-trip";

const USAGE = `
Usage: tsx scripts/seed-all.ts [options]

  --only <slugs>      Comma-separated cities to seed  (default: all itineraries)
  --placeholder       Use picsum.photos stand-ins rather than the Unsplash caches
  --no-geocode        Name places by coordinates, skipping the lookups entirely
  --force-geocode     Ignore cached names and look every place up again
  --help              Show this message
`.trimStart();

function datasetPathFor(city: string): string {
  return `data/${city}-trip.json`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      placeholder: { type: "boolean", default: false },
      "no-geocode": { type: "boolean", default: false },
      "force-geocode": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const out = (text = ""): void => {
    process.stdout.write(`${text}\n`);
  };

  const requested =
    values.only === undefined
      ? availableCities()
      : values.only
          .split(",")
          .map((slug) => slug.trim())
          .filter((slug) => slug.length > 0);

  // A city with an itinerary but no dataset has simply never been generated.
  // Skipping it with an instruction is friendlier than a file-not-found stack.
  const missing = requested.filter(
    (city) => !existsSync(resolve(process.cwd(), datasetPathFor(city))),
  );
  const cities = requested.filter((city) => !missing.includes(city));

  for (const city of missing) {
    out(`Skipping ${city}: no ${datasetPathFor(city)}.`);
    out(`  Run: npx tsx scripts/generate-trip.ts --city ${city}`);
    out();
  }

  if (cities.length === 0) {
    out("Nothing to seed.");
    return;
  }

  out(`Seeding ${cities.length} trips: ${cities.join(", ")}`);
  out();

  const seeded: SeedCitySummary[] = [];
  const failed: { city: string; message: string }[] = [];

  for (const city of cities) {
    out(`--- ${city} ${"-".repeat(Math.max(0, 68 - city.length))}`);

    try {
      seeded.push(
        await seedCity({
          city,
          placeholder: values.placeholder,
          geocode: !values["no-geocode"],
          forceGeocode: values["force-geocode"],
          log: out,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ city, message });
      out(`  FAILED: ${message}`);
    }

    out();
  }

  // --- summary ---------------------------------------------------------------

  const width = Math.max(...seeded.map((trip) => trip.slug.length), 4);

  out("Seeded");
  for (const trip of seeded) {
    out(
      `  ${trip.slug.padEnd(width)}  ` +
        `${String(trip.photos).padStart(4)} photos  ` +
        `${String(trip.places).padStart(2)} places  ` +
        `${String(trip.visits).padStart(2)} visits` +
        (trip.broken > 0 ? `  (${trip.broken} broken images)` : ""),
    );
  }

  if (failed.length > 0) {
    out();
    out(`${failed.length} failed:`);
    for (const failure of failed) out(`  ${failure.city}: ${failure.message}`);
    process.exitCode = 1;
  }

  out();
  out("Browse them at /trips");
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
