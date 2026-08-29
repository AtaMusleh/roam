/**
 * Loads `.env` for scripts.
 *
 * Next.js reads `.env` itself, but a script run under tsx does not, and
 * `src/lib/prisma.ts` throws at import time without `DATABASE_URL`. Import this
 * module **before** anything that reaches the database:
 *
 *     import "./load-env";
 *     import { prisma } from "../src/lib/prisma";
 *
 * Import order matters — TypeScript emits the requires in source order, so this
 * has to stay above the imports that depend on it.
 *
 * A real environment variable always wins: this only fills in what is missing,
 * so `DATABASE_URL=... npx tsx scripts/...` still points where it was told to.
 */

if (process.env.DATABASE_URL === undefined) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file. Fine — the variables may be set in the real environment,
    // and whatever needs them will say so clearly if they are not.
  }
}
