"use server";

import { redirect } from "next/navigation";
import { nativeReturnTo } from "@/lib/auth/return-to";
import { auth } from "@/lib/auth/server";
import { activeAccount, requestAccountApproval } from "@/lib/auth/accounts";

export type AuthFormState = { error: string } | null;

export async function signIn(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const { data, error } = await auth.signIn.email({ email, password });
  if (error) return { error: error.message || "Sign-in failed." };
  if (!data?.user?.id || !await activeAccount(data.user.id, email)) {
    if (data?.user?.id) { try { await requestAccountApproval(data.user.id, email); } catch { /* Remain inactive if email is unavailable. */ } }
    return { error: "Your account is inactive until an admin approves it by email." };
  }
  redirect(nativeReturnTo(formData.get("returnTo")));
}
