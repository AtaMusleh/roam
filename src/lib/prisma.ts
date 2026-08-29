import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Prisma 7 has no Rust query engine: the client talks to Postgres through a
 * driver adapter, so the `pg` pool below is the real connection pool and
 * creating a second client means creating a second pool.
 *
 * In development Next.js re-evaluates modules on every hot reload, which would
 * leak a pool per reload until Postgres refuses new connections. Caching on
 * `globalThis` survives module re-evaluation and keeps exactly one. In
 * production modules are evaluated once, so the cache is skipped and nothing is
 * left on the global object.
 */

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["error"],
  });
}

type RoamPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as typeof globalThis & {
  __roamPrisma?: RoamPrismaClient;
};

export const prisma: RoamPrismaClient =
  globalForPrisma.__roamPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__roamPrisma = prisma;
}
