"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "./actions";
import type { SignInState } from "./actions";

const INITIAL: SignInState = { error: null };

/**
 * The submit button, split out so it can read the form's pending state.
 *
 * `useFormStatus` only reports on the form above it in the tree, which is why
 * this is its own component rather than a branch inside the one below.
 */
function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      ) : (
        <LogIn aria-hidden className="size-4" />
      )}
      {pending ? "Checking…" : "Sign in"}
    </Button>
  );
}

/**
 * One password field.
 *
 * The error is rendered from the action's return value rather than from local
 * state, so what is shown is always the server's answer to the last thing
 * actually submitted. It is announced as an alert because a sighted user sees
 * it appear and a screen reader user otherwise would not.
 */
export function SignInForm() {
  const [state, action] = useActionState(signIn, INITIAL);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-describedby={state.error === null ? undefined : "sign-in-error"}
          aria-invalid={state.error !== null}
        />
      </div>

      {state.error !== null && (
        <p
          id="sign-in-error"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <Submit />
    </form>
  );
}
