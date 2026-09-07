"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState } from "react";
import ThemeToggle from "@/app/theme-toggle";
import { signIn } from "./actions";

export default function SignInForm() {
  const [state, action, pending] = useActionState(signIn, null);

  return (
    <main className="auth-page">
      <ThemeToggle className="auth-theme-toggle" />
      <section className="auth-card">
        <div className="auth-mark">
          <Image
            src="/defy-os-icon.png"
            alt="Defy OS"
            width={52}
            height={52}
            priority
          />
        </div>
        <p className="eyebrow">DEFY TCG · STORE OS</p>
        <h1>Welcome back</h1>
        <p className="auth-copy">
          Sign in to manage inventory, checkout, revenue, and pricing.
        </p>
        <form action={action}>
          <label>
            Email
            <input
              required
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              required
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </label>
          {state?.error && <p className="auth-error">{state.error}</p>}
          <button disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          First time here? <Link href="/auth/sign-up">Create your account</Link>
        </p>
      </section>
    </main>
  );
}