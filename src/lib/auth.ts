/**
 * The single-owner admin session.
 *
 * Roam has one writer and any number of readers. That is a narrow enough shape
 * that a full identity system would be more code than the problem deserves:
 * there are no accounts to create, no roles to resolve, nothing to reset. One
 * password and one signed cookie is the whole of it.
 *
 * ## Why a signed cookie rather than a stored session
 *
 * The cookie carries its own expiry and an HMAC over it. Nothing is written to
 * the database, which means no session table, no cleanup job, and no query on
 * the path of every mutation. The cost is that a session cannot be revoked
 * before it expires — signing out clears the cookie in that browser, but a copy
 * taken beforehand stays valid until its thirty days are up. Rotating
 * `SESSION_SECRET` invalidates every outstanding session at once, which is the
 * escape hatch if one is ever needed.
 *
 * ## What the signature does and does not do
 *
 * HMAC proves the cookie was minted here: the expiry cannot be pushed forward
 * and the token cannot be forged without the secret. It does not encrypt
 * anything, so nothing secret goes in the payload — it holds an expiry and a
 * nonce, and that is all it needs to hold.
 *
 * This module reads `next/headers`, so it is server-only by construction:
 * importing it into a client component fails at build time.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/** Name of the session cookie. */
export const SESSION_COOKIE = "roam_admin";

/** How long a session lasts. Long, because it is one person on their own machine. */
const SESSION_DAYS = 30;
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

/**
 * Prefix on every token.
 *
 * Changing it invalidates every outstanding session, which is what you want if
 * the payload's meaning ever changes: an old token must fail to verify rather
 * than be misread under the new rules.
 */
const TOKEN_VERSION = "v1";

/**
 * Shortest secret accepted.
 *
 * An HMAC is only as strong as its key, and a short one is brute-forceable
 * offline by anyone holding a single valid cookie. Thirty-two characters is
 * `openssl rand -base64 24`, which is the suggestion in `.env.example`.
 */
const MIN_SECRET_LENGTH = 32;

/** Whether the deployment can accept a sign-in at all, and why not if it cannot. */
export interface AdminConfig {
  configured: boolean;
  /** Safe to show on the sign-in page: it tells an attacker only that there is no way in. */
  problem: string | null;
}

export function adminConfig(): AdminConfig {
  const password = process.env.ADMIN_PASSWORD?.trim();
  const secret = process.env.SESSION_SECRET?.trim();

  if (!password) {
    return { configured: false, problem: "ADMIN_PASSWORD is not set on this deployment." };
  }

  if (!secret) {
    return { configured: false, problem: "SESSION_SECRET is not set on this deployment." };
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      configured: false,
      problem: `SESSION_SECRET is too short — it needs at least ${String(MIN_SECRET_LENGTH)} characters.`,
    };
  }

  return { configured: true, problem: null };
}

function secretKey(): string | null {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Compares two strings without leaking how far they matched.
 *
 * Both sides are hashed first so the comparison is over two equal-length
 * digests. `timingSafeEqual` throws on a length mismatch, which would itself be
 * a timing signal — and comparing raw inputs would leak their lengths.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHmac("sha256", "compare").update(a).digest();
  const digestB = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Whether a submitted password is the configured one. */
export function passwordMatches(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD?.trim();
  if (!expected || !adminConfig().configured) return false;

  return constantTimeEquals(candidate, expected);
}

/** Mints a token that expires `SESSION_MAX_AGE_SECONDS` from now. */
export function issueToken(now = Date.now()): string | null {
  const secret = secretKey();
  if (secret === null) return null;

  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  // A nonce so two sign-ins in the same millisecond still differ, and so a
  // token is never a pure function of its expiry.
  const payload = `${TOKEN_VERSION}.${String(expiresAt)}.${randomBytes(9).toString("base64url")}`;

  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Whether a token is genuine and still current.
 *
 * Signature first, expiry second: an unsigned token's expiry is not worth
 * reading, since the whole point of the signature is that the expiry inside it
 * can be trusted.
 */
export function verifyToken(token: string, now = Date.now()): boolean {
  const secret = secretKey();
  if (secret === null) return false;

  const parts = token.split(".");
  if (parts.length !== 4) return false;

  const [version, expiresAtRaw, , signature] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (expiresAtRaw === undefined || signature === undefined) return false;

  const payload = parts.slice(0, 3).join(".");
  if (!constantTimeEquals(signature, sign(payload, secret))) return false;

  const expiresAt = Number(expiresAtRaw);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * The local development override.
 *
 * `ALLOW_EDITS=true` unlocks editing without a password, which is what the
 * verification scripts run against. Deliberately inert in production: it is the
 * all-or-nothing switch the password gate exists to replace, and leaving it
 * live would mean a single mis-set variable reopened the door it closed.
 */
export function editsForcedOpen(): boolean {
  return (
    process.env.NODE_ENV !== "production" && process.env.ALLOW_EDITS === "true"
  );
}

/** Whether the current request carries a valid session cookie. */
export async function isSignedIn(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token !== undefined && verifyToken(token);
}

/**
 * Whether the current request may change anything.
 *
 * The one question every mutation asks, and the only one the UI asks before
 * offering the controls. Read it server-side on both sides of that pair, so
 * what is shown and what is permitted cannot drift apart.
 */
export async function canEdit(): Promise<boolean> {
  return editsForcedOpen() || (await isSignedIn());
}

/**
 * Starts a session in this browser.
 *
 * Only callable from a Server Action or Route Handler — cookies cannot be set
 * while a Server Component is rendering, because the headers have gone.
 */
export async function startSession(): Promise<void> {
  const token = issueToken();
  if (token === null) return;

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Off over plain HTTP so the cookie works against `next dev` on localhost.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * When the current session stops working, or null if there is not one.
 *
 * Read back out of the token rather than tracked separately — the expiry is
 * already in there and already signed, so this is the same fact the server will
 * check, not a second copy of it that could drift.
 */
export async function sessionExpiresAt(): Promise<Date | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || !verifyToken(token)) return null;

  const expiresAt = Number(token.split(".")[1]);
  return Number.isFinite(expiresAt) ? new Date(expiresAt) : null;
}

/** Ends the session in this browser. See the note above on revocation. */
export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
