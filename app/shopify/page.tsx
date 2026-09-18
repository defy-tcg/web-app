import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import ShopifyClient from "./shopify-client";
import "./shopify.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shopify stock & orders · Defy TCG",
  description: "View the Shopify inventory and orders connected to Defy TCG.",
  robots: { index: false, follow: false },
};

export default async function ShopifyPage() {
  const session = await getAuthorizedSession();
  if (!session) redirect("/auth/sign-in");
  return <ShopifyClient />;
}
