# Shopify Connector (Odoo module)

The Odoo-side half of the `odoo-connector` Shopify app. It doesn't call
Shopify or open any new HTTP endpoint of its own — the Shopify app calls
**into** it using Odoo's built-in External API
(`POST /json/2/<model>/<method>`), which is the exact endpoint
`app/services/odoo/client.server.ts` already talks to. This module just
adds the model methods worth calling, plus the identity fields and
sync log to make those calls fast and traceable.

## Install

1. Add this directory's parent to your Odoo `addons_path`, e.g. in
   `odoo19/odoo.conf`:
   ```
   Addons_path = /home/cybrosys/odoo19/addons,/home/cybrosys/odoo19/19.0,/home/cybrosys/shopify-development/odoo-connector/odoo_module
   ```
2. Restart Odoo, then in Apps (with developer mode / Update Apps List)
   install **Shopify Connector** on the `shopify_odoo` database.

## Create the technical user the Shopify app authenticates as

The app's `OdooClient` sends `Authorization: Bearer <apiKey>` — that key
is an Odoo API key belonging to one specific user, and everything the app
does happens under that user's identity in Odoo's logs.

1. Settings → Users → **New**. Name it e.g. `Shopify Connector`, give it
   a login/email that isn't a real mailbox, no password login needed.
2. Under **Other** (access rights), tick the **Shopify Connector User**
   group added by this module. Remove any other group defaults don't
   already require — this user should not be a Sales/Inventory user; the
   group only exists to gate who *may* get a Shopify API key at all.
3. Save, then open that user's own **My Profile → Account Security →
   New API Key**, description "Shopify app", no expiry (or set one and
   rotate it, your call). Copy the key immediately — Odoo shows it once.
4. Paste that key, the Odoo URL and the database name into the app's
   `/app/odoo` connection page.

## Why the sync methods use `sudo()`

The `shopify_sync_*` methods call `.sudo()` internally rather than
relying on the calling user's own permissions for the actual read/write.
That's a deliberate choice for an integration account: the real security
boundary here is *which methods are reachable at all* (Odoo's External
API only allows calling public, non-underscore methods — see
`odoo/service/model.get_public_method` — so only the methods this module
defines, nothing else) and *who can hold a Bearer key for this user*
(gated by the `Shopify Connector User` group above). Relying on the
technical user's own ir.model.access/record rules instead would mean
every new field or workflow this module touches needs its ACLs kept in
sync by hand, which is exactly the kind of drift that causes silent
partial syncs. `ir.model.access.csv` still grants the group real access,
so the boundary holds even if a future change drops a stray `sudo()`.

## RPC methods this module adds (Shopify → Odoo)

| Call (via `/json/2/<model>/<method>`) | Purpose |
| --- | --- |
| `product.template.shopify_sync_product(vals)` | Upsert one product; matches by `shopify_id`, falling back to SKU. |
| `product.template.shopify_archive_product(shopify_shop, shopify_id)` | Archive on Shopify `products/delete`. |
| `res.partner.shopify_sync_customer(vals)` | Upsert one contact; matches by `shopify_id`, falling back to email. |
| `res.partner.shopify_archive_customer(shopify_shop, shopify_id)` | Archive on Shopify `customers/delete`. |
| `sale.order.shopify_sync_order(vals)` | Upsert the order **and its customer and every line item, plus confirm/cancel/invoice/pay**, in one call. Replaces the app's current per-line-item RPC loop. |
| `product.product.shopify_stock_snapshot(shopify_shop, updated_since=None)` | Pull current available stock per Shopify-mapped warehouse, for the app's inventory reconciliation job. |

All calls (success or failure) are recorded in **Settings → Technical →
(or Shopify Connector menu, as system admin) → Shopify Sync Log**.

## Invoicing and payment for paid orders

Confirming a sale order (`action_confirm()`) does **not** create, post, or
pay any invoice on its own - those are three separate Odoo steps. A
Shopify order arriving with `financial_status: "PAID"` now gets all
three, inside the same `shopify_sync_order` call:

1. `order._create_invoices()` - only invoices what isn't invoiced yet
   (idempotent across the create/updated/paid webhooks Shopify sends for
   the same order).
2. `invoice.action_post()` on whatever was just created.
3. A payment registered via `account.payment.register` against a
   dedicated **Shopify Payments** journal (auto-created on first use,
   flagged by `account.journal.shopify_is_payments_journal` - move that
   flag to an existing journal instead if you'd rather route through one
   you already have).

That journal is deliberately **not** a real bank journal: Shopify holds
the money until its own payout schedule runs, so crediting a real bank
account immediately would overstate its balance until the payout
actually lands. Reconcile this journal's balance against the real payout
deposit when it arrives, the same way you would for Stripe/PayPal
held-funds accounting.

`PARTIALLY_REFUNDED` orders still confirm (a refund doesn't undo the
sale) but are **not** auto-invoiced/paid - the collected amount no longer
matches the order total, and correct partial-payment/credit-note
handling is a distinct feature. Invoice those manually for now.

## What's intentionally not in v1

- **Odoo → Shopify push.** Inventory and fulfillment are meant to be
  Odoo-authoritative (see the connector's own architecture guide), but
  right now the app only reads Shopify → Odoo; `shopify_stock_snapshot`
  above exists for the app to pull from on a schedule if/when that side
  is built, rather than Odoo pushing to it. A pull needs no outbound
  secret/URL stored in Odoo and no retry logic on the Odoo side.
- **Multi-company shop scoping enforcement.** `res.company.shopify_shop_domain`
  is reference-only for now; the sync methods trust whatever
  `shopify_shop` the caller sends rather than binding it to `env.company`.
  Fine for one shop per Odoo database; worth revisiting before one Odoo
  database serves multiple independent merchants.
