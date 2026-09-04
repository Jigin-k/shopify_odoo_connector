# App Store listing copy

Draft content for the Partner Dashboard's App Store listing fields
(App listing → Listing content). Paste and adjust as needed — this
isn't submitted anywhere automatically, it's just prepared here so the
prerequisite is stated consistently everywhere a merchant might read it.

## App icon

`public/store-listing/app-icon-1200.png` — 1200×1200 PNG, meets the
Partner Dashboard's App Store icon requirement (square, ≥1200px).
Same design as the in-app favicon (`public/icon.svg`): a dark badge
with two arced arrows forming a sync loop, kept abstract so it doesn't
borrow Shopify's or Odoo's actual branding. Upload it as-is under
App listing → Icon.

## Developer

**Cybrosys Technologies** ([www.cybrosys.com](https://www.cybrosys.com))

This is the name merchants see as the app's developer. It's driven by
your **Partner organization's public name**, not anything in this repo
or listing form — set it in Partner Dashboard under
**Settings → Public profile** (organization/business name), before
submitting. If your Partner org is currently named anything else
(a personal account, a different trade name, etc.), update it there
first — it can't be overridden per-app.

## App name

Odoo Connector

## Introduction (tagline, ~100 characters)

Sync products, customers, orders, and inventory between Shopify and Odoo in real time.

## Requires (Partner Dashboard has a dedicated "App requirements" /
## "Works with" field — use it here, in addition to the description below)

An Odoo instance (version 19) with the companion **Shopify Connector**
Odoo module installed.

## Description

Odoo Connector keeps your Shopify store and your Odoo ERP in sync,
automatically, without manual exports or spreadsheets.

**What it syncs, in real time:**
- Products — created and updated in Odoo the moment they change in Shopify, matched by variant so nothing gets duplicated on re-sync.
- Customers — synced for accurate contact records and order history in Odoo.
- Orders — including line items, tax, and payment status. Paid orders are automatically invoiced and marked paid in Odoo; refunds generate proper credit notes.
- Inventory — Odoo is treated as the source of truth for stock; on-hand quantity changes in Odoo are reflected back to Shopify automatically.

**Before you install:** this app works by connecting to a companion
module installed on your own Odoo server — it cannot connect to a
stock, unmodified Odoo instance. Have your Odoo administrator or
implementation partner install the **Shopify Connector** module first;
the app will prompt you for your Odoo connection details (URL,
database, and an API key) right after install.

Odoo Connector is developed and supported by **Cybrosys Technologies**.
*(Add your Odoo partner tier/credentials here if you'd like them
mentioned — left out since it's a factual claim you should confirm,
not something to draft on your behalf.)*

## Support

*(Fill in: support email, and a link to setup documentation covering
how to install the Shopify Connector Odoo module.)*

## Privacy policy URL

*(Required before submission — must accurately describe that customer
data collected via Shopify is synced into the merchant's own Odoo
instance.)*
