"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState } from "react";
import ThemeToggle from "@/app/theme-toggle";
import { signUp } from "./actions";

export default function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, null);

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
        <p className="eyebrow">PRIVATE OWNER ACCESS</p>
        <h1>Create your account</h1>
        <p className="auth-copy">
          Only approved Defy owner emails can register.
        </p>
        <form action={action}>
          <label>
            Name
            <input
              required
              name="name"
              autoComplete="name"
              placeholder="Your name"
            />
          </label>
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
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </label>
          {state?.error && <p className="auth-error">{state.error}</p>}
          <button disabled={pending}>
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="auth-switch">
          Already registered? <Link href="/auth/sign-in">Sign in</Link>
        </p>
      </section>
    </main>
  );
}