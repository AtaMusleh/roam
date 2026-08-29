/**
 * Applies `prisma/schema.prisma` to the database as raw DDL.
 *
 *   npx tsx scripts/push-schema.ts
 *
 * This exists only because Prisma's schema engine is a native binary, and this
 * machine's Windows Application Control policy refuses to launch it — so
 * `prisma db push` fails with `spawn UNKNOWN` before it reaches the database.
 * The statements below are the DDL that `db push` would have emitted for the
 * current schema, applied through the same `pg` driver the app uses.
 *
 * Every statement is idempotent, so re-running after adding a model creates
 * only what is missing. It is still a stopgap, not a migration tool: it adds,
 * and never alters or drops. A column whose type changed in the schema will
 * not change here. Once the schema engine can run (allow-list the binary, or
 * push from CI or WSL), delete this file and use `prisma db push` and
 * `prisma migrate` as normal.
 */

import { Client } from "pg";

/** Adds a foreign key only if a constraint of that name is not already there. */
function foreignKey(
  table: string,
  constraint: string,
  column: string,
  references: string,
  onDelete: "CASCADE" | "SET NULL",
): string {
  return `
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${constraint}'
      ) THEN
        ALTER TABLE "${table}"
          ADD CONSTRAINT "${constraint}" FOREIGN KEY ("${column}")
          REFERENCES "${references}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;
      END IF;
    END $$`;
}

const STATEMENTS: readonly string[] = [
  `DO $$ BEGIN
     CREATE TYPE "GpsSource" AS ENUM ('EXIF', 'INTERPOLATED', 'MANUAL', 'NONE');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  `CREATE TABLE IF NOT EXISTS "Trip" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "coverPhotoId" TEXT,
    "slug" TEXT NOT NULL,
    "utcOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE IF NOT EXISTS "Place" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE IF NOT EXISTS "Visit" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "departedAt" TIMESTAMP(3) NOT NULL,
    "sequence" INTEGER NOT NULL,
    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE IF NOT EXISTS "Photo" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "visitId" TEXT,
    "cloudinaryId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "blurhash" TEXT,
    "photographerName" TEXT,
    "photographerUrl" TEXT,
    "takenAt" TIMESTAMP(3),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "gpsSource" "GpsSource" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE IF NOT EXISTS "GeocodeCache" (
    "id" TEXT NOT NULL,
    "roundedLat" DOUBLE PRECISION NOT NULL,
    "roundedLng" DOUBLE PRECISION NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeocodeCache_pkey" PRIMARY KEY ("id")
  )`,

  // Columns added after the tables first shipped. `ADD COLUMN IF NOT EXISTS`
  // makes them safe on a database created before they existed and a no-op on
  // one created after.
  `ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "utcOffsetMinutes" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "photographerName" TEXT`,
  `ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "photographerUrl" TEXT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS "Trip_slug_key" ON "Trip"("slug")`,
  `CREATE INDEX IF NOT EXISTS "Place_tripId_idx" ON "Place"("tripId")`,
  `CREATE INDEX IF NOT EXISTS "Visit_placeId_arrivedAt_idx" ON "Visit"("placeId", "arrivedAt")`,
  `CREATE INDEX IF NOT EXISTS "Photo_tripId_takenAt_idx" ON "Photo"("tripId", "takenAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "GeocodeCache_roundedLat_roundedLng_key"
     ON "GeocodeCache"("roundedLat", "roundedLng")`,

  foreignKey("Place", "Place_tripId_fkey", "tripId", "Trip", "CASCADE"),
  foreignKey("Visit", "Visit_placeId_fkey", "placeId", "Place", "CASCADE"),
  foreignKey("Photo", "Photo_tripId_fkey", "tripId", "Trip", "CASCADE"),
  foreignKey("Photo", "Photo_visitId_fkey", "visitId", "Visit", "SET NULL"),
];

async function main(): Promise<void> {
  process.loadEnvFile(".env");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // All or nothing: Postgres runs DDL transactionally, so a failure halfway
    // through leaves the database exactly as it was.
    await client.query("BEGIN");
    for (const statement of STATEMENTS) {
      await client.query(statement);
    }
    await client.query("COMMIT");

    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );

    process.stdout.write(
      `Applied ${STATEMENTS.length} statements.\n` +
        `Tables: ${rows.map((row) => row.table_name).join(", ")}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
