# Handoff: Odoo Connector (Shopify app)

Status as of this handoff: **development complete, production launch not
started.** Everything below is exactly what remains, and who needs to do
it - nothing here has been guessed or assumed.

## What's done and verified

- Full sync: products, customers, orders (with tax + refunds/credit
  notes), and one-directional inventory sync (Odoo → Shopify, on a
  90-second poll).
- Companion Odoo module (`odoo_module/shopify_connector/`) - required
  on the merchant's Odoo instance for the app to function at all. See
  `odoo_module/shopify_connector/README.md` for its own setup.
- All 3 mandatory Shopify compliance webhooks implemented
  (`customers/data_request`, `customers/redact`, `shop/redact`).
- Tested end-to-end on a development store: install, Odoo connection,
  product/customer/order sync, inventory pull.
- `npm run typecheck` and `npm run lint` both pass clean.

## What's NOT done - and exactly who needs to decide/do each one

1. **Production hosting** - not deployed anywhere yet.
   `shopify.app.toml`'s `application_url`/`redirect_urls` are still the
   `https://example.com` placeholder. Plan is to deploy to the company's
   existing AWS server (see `AWS_DEPLOY.md`) rather than a third-party
   platform, since it's already provisioned and avoids a new recurring
   cost. Whoever has SSH/sudo access to that server and can point a
   domain at it needs to run through that guide.
   *(Whatever server this ends up on, one constraint doesn't change:
   this app runs a background inventory poller that must never be
   allowed to sleep - so it needs to be a persistent, always-on process,
   not anything that scales to zero when idle.)*

2. **Billing model** - free vs. paid app, still undecided. A paid app
   requires integrating Shopify's Billing API before submission. This is
   a revenue decision.

3. **Shopify Partner Dashboard access** - whoever handles steps 4-6
   below needs access to the Partner organization that owns this app's
   `client_id` (already set in `shopify.app.toml`). If they're not
   already a member, they need to be invited into that org first.

4. **Push config to Shopify** - once hosting is live, update
   `shopify.app.toml`'s URLs to the real hosted URL, then run
   `npm run deploy` (`shopify app deploy`) to push that config.

5. **App Store listing** - draft content ready to paste in at
   `APP_STORE_LISTING.md`, plus a ready-to-upload icon at
   `public/store-listing/app-icon-1200.png`. Needs a support email and
   a privacy policy URL filled in (both flagged as placeholders in that
   file) before submission.

6. **Submit for review** - via the Partner Dashboard's App Store review
   page (runs automated checks first), then Shopify's review team takes
   over.

## Credentials - hand these over out-of-band, never via chat/email/git

- `SHOPIFY_API_SECRET` (the app's client secret, from the Partner
  Dashboard) - needed to set as a hosting secret.
- Odoo API key(s) used for any test connections - rotate before handing
  off if they were shared in plaintext anywhere.
- None of these are in the repo - `.gitignore` already excludes `.env`
  and it was verified clean before the first commit.

## Where the code lives right now

Committed locally (`git log` shows one commit) but **not yet pushed to
any remote** - there's no GitHub/GitLab repo yet. That's the first thing
needed for an actual handoff: create a repo under the team's
organization, push this history to it, and add the team lead (and
whoever ends up deploying) as a collaborator.
