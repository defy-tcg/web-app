"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { isAllowedEmail } from "@/lib/auth/authorization";

export type AuthFormState = { error: string } | null;

export async function signIn(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!isAllowedEmail(email)) return { error: "This email is not authorized for Defy." };
  const { error } = await auth.signIn.email({ email, password });
  if (error) return { error: error.message || "Sign-in failed." };
  redirect("/");
}