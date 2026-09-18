import { auth } from "@/lib/auth/server";

export default auth.middleware({
  loginUrl: "/auth/sign-in",
});

export const config = {
  matcher: [
    // These Shopify endpoints authenticate with HMAC / the cron secret.
    // Keep every other inventory and integration endpoint behind Neon Auth.
    "/((?!api/auth|api/shopify/webhooks$|api/shopify/sync/drain$|api/shopify/pricing/cron$|auth|_next/static|_next/image|favicon.ico|favicon.svg).*)",
  ],
};
