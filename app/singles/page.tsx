import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import SinglesClient from "./singles-client";
import "./singles.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Riftbound singles · Defy TCG",
  description:
    "Find English Riftbound cards and receive your singles inventory.",
};

export default async function SinglesPage() {
  const session = await getAuthorizedSession();
  if (!session) redirect("/auth/sign-in");
  return <SinglesClient />;
}
