# Shared account approval

The additive migration in db/account-approval.sql uses the existing Neon identity database and never changes inventory. The two explicitly requested admin identities are bootstrapped. All other directory entries default to PENDING STAFF. The old email allowlist no longer grants access.

Web session authorization, native approval, PKCE exchange and device checks use this shared directory. Missing, disabled, deleted, banned and email-mismatched identities are rejected. Native grant writes recheck active status within SQL. The installed app keeps its existing Keychain connection protocol; no binary change is required.

Registration creates a Neon credential identity and an inactive directory entry. Direct provider registration cannot grant application access. Client input never controls shared roles. Signing in to an inactive identity retries approval delivery, limited to one request per recipient per 15 minutes. Approval requires an active ADMIN's authenticated server action and matching email challenge. HMAC-signed links are recipient-bound, single-use and valid for 24 hours. GET never approves. The review screen shows the requested email and has no-referrer, no-store and frame restrictions. Activation records the admin and timestamp and grants STAFF only.

Configure RESEND_API_KEY and ACCOUNT_APPROVAL_FROM with a verified sender in Vercel production, then deploy. A Gmail address alone does not authorize server email delivery. ACCOUNT_APPROVAL_SECRET is optional; otherwise the existing cookie secret signs domain-separated tokens. Rotating the signing secret invalidates outstanding links.

Missing email configuration and delivery errors leave accounts inactive. Sign in again to retry delivery after configuration. Expired links require a fresh request. Normal activation must use email confirmation; operator bootstrap is restricted to the two requested admins.

Run npm test. The approval policy tests check signature, tampering, recipient, expiry and nonce behavior. scripts/account-approval.integration.mjs tests real SQL and native grants with synthetic users on the isolated approval validation branch; email transport is mocked. The existing native integration suite also needs the additive migration on its isolated branch. Never point integration scripts at production.
