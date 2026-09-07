import Image from "next/image";
import ThemeToggle from "@/app/theme-toggle";
import { signOut } from "./actions";

export default function UnauthorizedPage() {
  return (
    <main className="auth-page">
      <ThemeToggle className="auth-theme-toggle" />
      <section className="auth-card">
        <div className="auth-mark">
          <Image
            src="/defy-os-icon.png"
            alt="Defy OS"
            width={52}
            height={52}
            priority
          />
        </div>
        <p className="eyebrow">ACCESS RESTRICTED</p>
        <h1>Not an approved owner</h1>
        <p className="auth-copy">
          This account does not have access to the Defy store system.
        </p>
        <form action={signOut}>
          <button>Use another account</button>
        </form>
      </section>
    </main>
  );
}