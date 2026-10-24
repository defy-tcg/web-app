# Native Warehouse shared accounts

The current macOS Warehouse application uses the existing Defy OS Neon account
directory and authorized-email policy. It does not create another password
database or expand the old scanner companion key permissions.

## Connection protocol

All native requests use the canonical HTTPS origin
`https://defy-store-os.vercel.app`. The native API is exactly
`/api/native-warehouse`; other APIs keep their existing authentication policy.

1. Native generates an RFC 7636 verifier and sends its S256 challenge in
   `POST ?action=start`, JSON `{challenge, name?}`.
2. The response has `requestId`, `verificationCode`, `authorizationURL`, and
   `expiresAt`. The authorization URL is exactly
   `/native-warehouse/authorize?requestId=<uuid>`. It carries no token or verifier.
3. The operator opens that URL in the system browser, signs in to their existing
   authorized Defy account, matches the code in the Warehouse app, and explicitly
   approves the connection. Browser approval requires the same-origin cookie
   session; bearer credentials cannot approve themselves.
4. Native polls `POST ?action=exchange`, JSON `{requestId, verifier}`. HTTP 202
   means pending approval. The request expires after ten minutes. Approval is
   consumed atomically once; replay returns 409. A lost successful exchange
   response requires a new sign-in; no token is recoverable from stored hashes.
5. Successful exchange returns `{token, account:{id,email,name},
   device:{id,name,expiresAt}, validatedAt}`. Timestamps are ISO 8601 UTC.
6. `GET ?action=session` with the native Bearer credential returns the same
   account/device/validation fields without a token. Each check reads the
   current shared user record and authorization policy. Deleted or banned users,
   removed authorized emails, expired connections, and revoked devices fail.
7. `POST ?action=revoke`, JSON `{}`, revokes only the bearer credential's own
   device. Owners can also revoke their connections at `/native-warehouse`.

Native credentials are identity grants only. They do not grant access to any
Store OS business API, old scanner API, inventory write, database credentials,
or administrative role. The desktop app keeps its native inventory workflow.
Each native connection expires after 30 days. Signing out of the website does
not automatically revoke separate device connections; use the management page
to disconnect a Mac. Deleted/banned accounts and current allowlist changes are
checked at the next native validation.

## Storage and concurrency

`defy_native_auth` is an additive schema in the primary `DATABASE_URL` database.
It contains `requests`, `devices`, and durable `rate_limits` tables. Initialization
uses a transaction-scoped advisory lock so concurrent cold starts cannot race
table creation. It does not modify the managed `neon_auth` schema, existing store
tables, inventory, or the old companion schema.

Device secrets use 256 random bits; only SHA-256 hashes are stored. Every native
connection belongs to the authenticated account ID. Token verification is
constant time. Account existence, current email, and banned status come from
`neon_auth."user"`, not client-supplied fields or stale snapshots.

Separate transaction statements lock an owner before counting active grants;
atomic request consumption and device insertion share one transaction. At most
ten active/approved connections per owner are permitted. There are at most five
pending requests per source and 300 globally. Durable global and per-source
limits bound starts, exchanges, and native session lookups across Vercel
instances. Client addresses are HMAC-hashed; raw addresses are not persisted.
Expired rate/request records are periodically cleaned during any native API use.

Browser mutations require an exact same Origin, JSON, and an authorized session.
All bodies are bounded to 2 KiB while streaming, even without Content-Length.
Native routes use no-store responses and never reflect database/provider errors.
Native authorization pages forbid framing and send no referrer. Sign-in and
sign-up may resume only the exact allowlisted native management or authorization
paths; other return-path inputs retain the existing dashboard destination.

## Validation and release

Run `npm test` using the existing locked dependencies. The focused native tests
cover the RFC PKCE vector, malformed credentials, cookie/scanner isolation,
open redirects, CSRF, body limits, unauthorized-account decisions, revocation
ownership, pending/expired handoffs, rate-guard order, and secret-safe errors.

Use a development Neon branch for real database/interactive sign-in testing.
Do not exercise production inventory pages for this test: their automatic
master-sheet synchronization is unrelated to native authentication. The first
native connection initializes only this feature's new schema. No speculative
Drizzle migration or change to existing authentication records is required.

### Real database integration check

Use Node 24 and create a disposable development branch first. Put only that
branch's connection string in the ignored `.env.local`. The branch ID and exact
endpoint hostname below must come from the new branch creation result. Do not
use the production branch or assume that a copied connection points at test data.

```bash
NATIVE_SOURCE_ROOT="$PWD" \
NATIVE_AUTH_TEST_MODE=isolated-branch \
NATIVE_AUTH_TEST_BRANCH_ID=br-your-disposable-test-branch \
NATIVE_AUTH_TEST_EXPECTED_DB_HOST=ep-your-test-endpoint.us-east-1.aws.neon.tech \
NODE_ENV=production \
node --env-file=.env.local --experimental-strip-types --conditions=react-server \
  --import ./scripts/native-warehouse-test-resolver.mjs \
  ./scripts/native-warehouse-auth.integration.mjs
```

The harness refuses the known production branch and mismatched endpoint hosts.
It creates two synthetic `example.com` users on the isolated branch and overrides
the authorized-email list only inside its test process. It never needs a user's
password, sends no provider sign-in request, and does not print connection strings,
account identities, or native tokens. Synthetic users, requests, devices, and
their rate buckets are cleaned in `finally`; discard the disposable branch after
the run. Global rate-window counters remain only in the disposable branch.

The 18 checks execute the actual store implementation and SQL, including six
concurrent schema initializers, eight simultaneous exchanges yielding exactly one
credential, wrong-proof rejection, cross-account approval/revocation, current
account changes and deletion, expiry, both device-count gates, durable rate
limits, pending-request caps, and visibility of older active devices. The resolver
only accommodates Next.js's extensionless imports for this standalone Node test;
it does not replace authentication or mock the database.

The desktop side must securely store its token, enforce locking and online
revalidation, and protect local imports/runtime separately. Shared sign-in is
not antivirus software and cannot by itself prevent a compromised macOS user
account from reading unencrypted local files.
