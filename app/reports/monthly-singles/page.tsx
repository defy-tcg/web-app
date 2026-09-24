import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import MonthlySinglesClient from "./report-client";
import "./monthly-singles.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Monthly singles sales · Defy TCG",
  description: "Defy TCG’s monthly singles sales across Shopify POS and web orders.",
  robots: { index: false, follow: false },
};

export default async function MonthlySinglesPage() {
  const session = await getAuthorizedSession();
  if (!session) redirect("/auth/sign-in");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const initialMonth = `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
  return <MonthlySinglesClient initialMonth={initialMonth} />;
}
