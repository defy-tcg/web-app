"use server";

import { auth } from "@/lib/auth/server";
import { requestAccountApproval } from "@/lib/auth/accounts";
import type { AuthFormState } from "../sign-in/actions";

export async function signUp(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 128) return { error: "Enter a valid name and email." };
  if (password.length < 8) return { error: "Use at least 8 characters for your password." };
  const { data, error } = await auth.signUp.email({ name, email, password });
  if (error) return { error: error.message || "Account creation failed." };
  if (!data?.user?.id) return { error: "Account creation could not be confirmed." };
  try { await requestAccountApproval(data.user.id, email); }
  catch (error) { return { error: error instanceof Error && error.message.startsWith("Your account is inactive.") ? error.message : "Your account is inactive. Contact an admin for approval." }; }
  return { error: "Your account is inactive until an admin approves it by email. You can sign in after approval." };
}
