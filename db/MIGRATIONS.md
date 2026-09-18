# Shopify synchronization schema

The recovered application has no historical Drizzle migration journal. Do not
run a generated initial migration or `drizzle-kit push` against this database.

`baseline-2026-09-18.json` and `baseline-constraints-2026-09-18.json` record the
public schema inherited by development branch `br-shiny-mud-afd6okid` from
production branch `br-falling-voice-af2e9bhg`. They contain schema metadata only.
The baseline has 22 tables, including older catalog/export tables not represented
in the recovered application schema. Existing products also have
`low_price_cents`, price history has `low_price_cents` and `source_version`, and
inventory movements have `request_key`; these are preserved.

The reviewed `migrations/shopify-sync.sql` adds only six `shopify_*` projection
and delivery tables with their indexes. Its Drizzle definitions live in
`shopify-schema.ts`. It does not alter, recreate, copy, or delete legacy tables,
stock quantities, sales, authentication records, or Shopify receipt journals.

The migration was applied to the development branch using a direct connection.
Neon's schema comparison against the parent confirmed only the six new tables,
their primary keys, and four indexes were added. Production application remains
a separate release step after integration validation and a fresh schema check.

Keep this additive migration immutable after production application. Future
changes must add a new reviewed migration; the schema baseline is evidence,
not SQL to apply. Resolve the complete historical baseline before introducing
automatic full-schema Drizzle migration generation.
