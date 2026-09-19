import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import SkuLabelsClient from "./sku-labels-client";
import "./sku-labels.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "QR SKU labels · Defy TCG",
  description: "Make custom QR SKU labels for singles on 38 × 13 mm thermal paper.",
  robots: { index: false, follow: false },
};

export default async function SkuLabelsPage() {
  if (!(await getAuthorizedSession())) redirect("/auth/sign-in");
  return <SkuLabelsClient />;
}
