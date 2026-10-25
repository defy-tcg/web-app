import Link from "next/link";
import { redirect } from "next/navigation";
import StoreOS from "./store-client";
import { getAuthorizedSession } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export default async function StorePage() {
  const session = await getAuthorizedSession();
  if (!session?.user) redirect("/auth/sign-in");
  return <>
    <StoreOS />
    <nav aria-label="Operating system switcher" className="print:hidden" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 35 }}>
      <Link href="/os" style={{ display: "inline-flex", padding: "10px 16px", borderRadius: 12, background: "#173e30", color: "#ffffff", border: "1px solid #719880", boxShadow: "0 4px 18px #0002", textDecoration: "none", fontSize: 12, fontWeight: 700 }}>⇄ Switch OS</Link>
    </nav>
  </>;
}
