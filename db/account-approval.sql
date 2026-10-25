-- Additive identity-only migration. Apply on a development branch first.
CREATE SCHEMA IF NOT EXISTS defy_accounts;
CREATE TABLE IF NOT EXISTS defy_accounts.directory (
  user_id text PRIMARY KEY, email text NOT NULL,
  role text NOT NULL DEFAULT 'STAFF' CHECK (role IN ('ADMIN','STAFF')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  approved_by text, approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS defy_accounts.approvals (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES defy_accounts.directory(user_id),
  admin_id text NOT NULL REFERENCES defy_accounts.directory(user_id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_approval_user ON defy_accounts.approvals(user_id,created_at);
-- Explicit bootstrap only. Never trust a client-supplied role or identity claim.
INSERT INTO defy_accounts.directory(user_id,email,role,status,approved_by,approved_at)
SELECT id::text,lower(email),'ADMIN','ACTIVE','operator-bootstrap',now()
FROM neon_auth."user" WHERE lower(email) IN ('nottandao@gmail.com','leducduy42@gmail.com') AND COALESCE(banned,false)=false
ON CONFLICT(user_id) DO NOTHING;
