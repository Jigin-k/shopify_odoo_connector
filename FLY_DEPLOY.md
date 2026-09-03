# Deploying to Fly.io

`fly.toml` and `Dockerfile` are already prepared. What's left needs your
own Fly account and Shopify Partner access, so it's not something that
can be done from inside this repo automatically. Follow these steps in
order.

## 1. Install the Fly CLI and sign up

```bash
curl -L https://fly.io/install.sh | sh
fly auth signup   # or `fly auth login` if you already have an account
```

## 2. Launch the app (uses the existing fly.toml/Dockerfile)

```bash
fly launch --no-deploy
```

- It will detect `fly.toml` already exists and ask to reuse it - say yes.
- If it asks for an app name, `odoo-connector` may already be taken
  globally on Fly - pick something unique (e.g. `cybrosys-odoo-connector`)
  and update the `app = "..."` line in `fly.toml` to match.
- `--no-deploy` skips the first deploy so secrets/database can be set up
  first (see below) - deploying before that would just crash-loop.

## 3. Create and attach a production Postgres database

```bash
fly postgres create --name odoo-connector-db
fly postgres attach odoo-connector-db
```

`fly postgres attach` automatically sets the `DATABASE_URL` secret on
the app - no manual copy-pasting of a connection string needed.

## 4. Set the remaining required secrets

These come from your app's config in the Partner Dashboard / Dev
Dashboard (Overview page has the Client ID and Client secret):

```bash
fly secrets set \
  SHOPIFY_API_KEY="<client id>" \
  SHOPIFY_API_SECRET="<client secret>" \
  SCOPES="write_products,read_customers,read_orders,read_inventory,write_inventory,read_locations,read_markets_home,write_metaobjects,write_metaobject_definitions" \
  SHOPIFY_APP_URL="https://<your-fly-app-name>.fly.dev"
```

- `SCOPES` must match `access_scopes.scopes` in `shopify.app.toml` exactly.
- `SHOPIFY_APP_URL` must match the app's actual Fly hostname - you'll
  know it for certain after step 5 (`fly status` shows it), but it
  follows the pattern `https://<app-name>.fly.dev`.
- Optional: `INVENTORY_SYNC_INTERVAL_MS` to change the inventory poll
  interval from its 90-second default.

## 5. Deploy

```bash
fly deploy
```

This builds the existing `Dockerfile` and starts one always-on machine
(`min_machines_running = 1` in `fly.toml` - required so the background
inventory poller never gets scaled to zero between requests).

Confirm it's live:

```bash
fly status
fly logs
```

## 6. Point the Shopify app config at the real URL

Once deployed, `shopify.app.toml` still has the `https://example.com`
placeholder - update it to the real Fly URL from step 5:

```toml
application_url = "https://<your-fly-app-name>.fly.dev"

[auth]
redirect_urls = [ "https://<your-fly-app-name>.fly.dev/api/auth" ]
```

Then push that config to Shopify:

```bash
npm run deploy   # runs `shopify app deploy`
```

## 7. Verify end-to-end

- Open `https://<your-fly-app-name>.fly.dev` directly - should not
  error (embedded apps still respond, just outside the admin iframe).
- Install the app on a development store and confirm the Odoo
  Connection page loads and a test connection succeeds.
- Check `fly logs` for the periodic `Inventory pull` sync events to
  confirm the background poller survived the deploy.

## Notes

- `fly deploy` is safe to re-run any time you push code changes - it
  builds fresh from the `Dockerfile` and replaces the running machine.
- Database migrations run automatically on boot (`npm run docker-start`
  → `prisma migrate deploy`), so a `fly deploy` after a schema change
  is enough; no separate migration step needed.
- Fly billing: a single always-on `shared-cpu-1x`/512mb machine plus a
  small Postgres instance is inexpensive but not free - check current
  Fly pricing before deploying if that matters for now.
