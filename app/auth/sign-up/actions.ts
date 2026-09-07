"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { isAllowedEmail } from "@/lib/auth/authorization";
import type { AuthFormState } from "../sign-in/actions";

export async function signUp(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!isAllowedEmail(email)) return { error: "This email is not authorized for Defy." };
  if (password.length < 8) return { error: "Use at least 8 characters for your password." };
  const { error } = await auth.signUp.email({ name, email, password });
  if (error) return { error: error.message || "Account creation failed." };
  redirect("/");
}