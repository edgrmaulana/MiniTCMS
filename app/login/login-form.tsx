"use client";

import { useActionState } from "react";
import { login, type LoginState } from "../auth-actions";

const INITIAL: LoginState = { error: null, email: "" };

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-xs uppercase tracking-[0.18em] text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          spellCheck={false}
          placeholder="you@example.com"
          defaultValue={state.email}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "login-error" : undefined}
          className="field"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-xs uppercase tracking-[0.18em] text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "login-error" : undefined}
          className="field"
        />
      </div>

      {state.error ? (
        <p id="login-error" role="alert" className="text-sm text-alert">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className="signin">
        {pending ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
