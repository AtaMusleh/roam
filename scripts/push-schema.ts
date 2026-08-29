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
 * It is a stopgap, not a migration tool: it creates the schema from empty and
 * does nothing else. Once the schema engine can run (allow-list the binary, or
 * push from CI or WSL), delete this file and use `prisma db push` and
 * `prisma migrate` as normal.
 */

import { Client } from "pg";

const STATEMENTS: readonly string[] = [
  `CREATE TYPE "GpsSource" AS ENUM ('EXIF', 'INTERPOLATED', 'MANUAL', 'NONE')`,

  `CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "coverPhotoId" TEXT,
    "slug" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE "Place" (
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

  `CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "departedAt" TIMESTAMP(3) NOT NULL,
    "sequence" INTEGER NOT NULL,
    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "visitId" TEXT,
    "cloudinaryId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "blurhash" TEXT,
    "takenAt" TIMESTAMP(3),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "gpsSource" "GpsSource" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
  )`,

  `CREATE UNIQUE INDEX "Trip_slug_key" ON "Trip"("slug")`,
  `CREATE INDEX "Place_tripId_idx" ON "Place"("tripId")`,
  `CREATE INDEX "Visit_placeId_arrivedAt_idx" ON "Visit"("placeId", "arrivedAt")`,
  `CREATE INDEX "Photo_tripId_takenAt_idx" ON "Photo"("tripId", "takenAt")`,

  `ALTER TABLE "Place"
     ADD CONSTRAINT "Place_tripId_fkey" FOREIGN KEY ("tripId")
     REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE`,

  `ALTER TABLE "Visit"
     ADD CONSTRAINT "Visit_placeId_fkey" FOREIGN KEY ("placeId")
     REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE`,

  `ALTER TABLE "Photo"
     ADD CONSTRAINT "Photo_tripId_fkey" FOREIGN KEY ("tripId")
     REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE`,

  `ALTER TABLE "Photo"
     ADD CONSTRAINT "Photo_visitId_fkey" FOREIGN KEY ("visitId")
     REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
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

    process.stdout.write(
      `Applied ${STATEMENTS.length} statements to the database.\n`,
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
