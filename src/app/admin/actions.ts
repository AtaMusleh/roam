"use server";

/**
 * Sign in and sign out.
 *
 * Both set or clear the session cookie, which is why they are Server Actions
 * rather than anything rendered: cookies can only be written where the response
 * headers are still open.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { checkAttempt, clearAttempts, recordFailure } from "@/lib/attempt-limit";
import { adminConfig, endSession, passwordMatches, startSession } from "@/lib/auth";

/**
 * What the form shows after a submission.
 *
 * A type rather than a value, because every *value* exported from a
 * `"use server"` module has to be an async function — the whole file is a
 * table of callable endpoints.
 */
export interface SignInState {
  /** What to show under the field, or null when nothing has been tried yet. */
  error: string | null;
}

/**
 * The same sentence for a wrong password, an empty field, and an unconfigured
 * deployment.
 *
 * A message that distinguished them would answer questions worth asking: that
 * the field reached the server, that the password is checked at all, that this
 * particular guess was closer than the last. None of that helps the one person
 * who knows the password.
 */
const GENERIC_FAILURE = "That password was not accepted.";

/**
 * Who is knocking, for rate-limiting purposes.
 *
 * `x-forwarded-for` is set by whatever proxy sits in front — the first entry is
 * the client as that proxy saw it. It is trivially spoofable when nothing
 * trustworthy sets it, so this is a speed bump against guessing rather than a
 * defence against a determined attacker with a pool of addresses; the password
 * itself is what has to hold. Everything unattributable shares one bucket,
 * which fails toward limiting rather than toward letting through.
 */
async function clientKey(): Promise<string> {
  const header = await headers();

  const forwarded = header.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  const real = header.get("x-real-ip")?.trim();
  if (real) return real;

  return "unattributed";
}

function retryMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));

  return (
    `Too many attempts. Try again in ${String(minutes)} ` +
    `${minutes === 1 ? "minute" : "minutes"}.`
  );
}

export async function signIn(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const key = await clientKey();

  // Checked before the password is looked at, so being locked out and being
  // wrong are indistinguishable in timing as well as in wording.
  const verdict = checkAttempt(key);
  if (!verdict.allowed) {
    return { error: retryMessage(verdict.retryAfterSeconds) };
  }

  const config = adminConfig();
  if (!config.configured) {
    // Not counted as an attempt: there is nothing to guess, and locking the
    // owner out of a deployment they are still configuring helps nobody.
    return { error: config.problem };
  }

  const submitted = formData.get("password");
  const password = typeof submitted === "string" ? submitted : "";

  if (password.length === 0 || !passwordMatches(password)) {
    recordFailure(key);
    return { error: GENERIC_FAILURE };
  }

  clearAttempts(key);
  await startSession();

  // Outside any try/catch: `redirect` signals by throwing, and catching it
  // would turn a successful sign-in into a swallowed error. The redirect is
  // what re-renders `/admin` as the signed-in view — the cookie is set on the
  // server, so nothing on the client knows about it until the page comes back.
  redirect("/admin");
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/admin");
}
