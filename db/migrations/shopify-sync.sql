-- Additive Shopify projections only. Apply after reviewing the baseline, first on a development Neon branch.
-- Existing products, inventory_movements, sales, sale_items, and receiving journals are untouched.
BEGIN;
CREATE TABLE IF NOT EXISTS shopify_products (
  shop text NOT NULL, id text NOT NULL, parent_id text, source_updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL, synced_at timestamptz NOT NULL DEFAULT now(), deleted boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL, PRIMARY KEY (shop, id)
);
CREATE TABLE IF NOT EXISTS shopify_variants (LIKE shopify_products INCLUDING ALL);
CREATE TABLE IF NOT EXISTS shopify_inventory (LIKE shopify_products INCLUDING ALL);
CREATE TABLE IF NOT EXISTS shopify_orders (LIKE shopify_products INCLUDING ALL);
CREATE TABLE IF NOT EXISTS shopify_order_lines (LIKE shopify_products INCLUDING ALL);
CREATE INDEX IF NOT EXISTS shopify_variants_parent_idx ON shopify_variants(shop, parent_id);
CREATE INDEX IF NOT EXISTS shopify_inventory_parent_idx ON shopify_inventory(shop, parent_id);
CREATE INDEX IF NOT EXISTS shopify_order_lines_parent_idx ON shopify_order_lines(shop, parent_id);
CREATE TABLE IF NOT EXISTS shopify_webhook_inbox (
  shop text NOT NULL, id text NOT NULL, topic text NOT NULL, resource_id text NOT NULL, location_id text,
  triggered_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed','complete')),
  attempts integer NOT NULL DEFAULT 0, lease_token text, lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (shop, id)
);
CREATE INDEX IF NOT EXISTS shopify_webhook_pending_idx ON shopify_webhook_inbox(shop, status, next_attempt_at);
COMMIT;
