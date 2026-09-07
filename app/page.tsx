import { redirect } from "next/navigation";
import StoreOS from "./store-client";
import { auth } from "@/lib/auth/server";
import { isAllowedEmail } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export default async function StorePage() {
  const { data: session } = await auth.getSession();
  if (!session?.user) redirect("/auth/sign-in");
  if (!isAllowedEmail(session.user.email)) redirect("/auth/unauthorized");
  return <StoreOS />;
}