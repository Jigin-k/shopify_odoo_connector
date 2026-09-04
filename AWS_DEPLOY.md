# Deploying to the company's AWS server

This assumes a plain Linux server (EC2 instance) with SSH/sudo access -
not a managed platform, so there's more manual setup than Fly.io/Render
would need, but no new hosting account or bill. Adjust the exact
commands if the server isn't Ubuntu (e.g. Amazon Linux uses `dnf`/`yum`
instead of `apt`).

## 0. Before starting - two hard requirements

- **A domain or subdomain pointed at this server's public IP**
  (e.g. `odoo-connector.yourcompany.com` → an A record → the EC2
  instance's Elastic IP). Shopify requires the app URL to be HTTPS -
  there's no way around this, and you can't get a valid TLS certificate
  for a bare IP address.
- **Security group / firewall allows inbound 80 and 443** (443 for the
  app itself once TLS is set up, 80 only needed transiently for the
  Let's Encrypt certificate challenge). Port 3000 does **not** need to
  be open externally - only nginx (on 80/443) talks to it, on localhost.

If this server already runs something else on ports 80/443 (another
site, a reverse proxy already in use for Odoo, etc.), this app needs to
share it via a separate server block/domain rather than the steps below
assuming a blank nginx config - flag that before proceeding so the
existing service isn't broken.

## 1. Install Docker (skip if already installed)

```bash
ssh <user>@<server>
docker --version   # check first - if this works, skip to step 2

# If not installed (Ubuntu):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

## 2. Get the code onto the server

Once the repo has a remote (see `HANDOFF.md` - it isn't pushed anywhere
yet):

```bash
git clone <your-repo-url> odoo-connector
cd odoo-connector
```

For future updates, `git pull` here and re-run the build/deploy steps
below - no need to re-clone.

## 3. Set up Postgres

Simplest option - run Postgres as a second container alongside the app,
using Docker Compose:

```yaml
# docker-compose.yml (create this at the repo root)
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: odoo_connector
      POSTGRES_PASSWORD: <choose-a-strong-password>
      POSTGRES_DB: odoo_connector
    volumes:
      - pgdata:/var/lib/postgresql/data

  app:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # bound to localhost only - nginx proxies to it
    environment:
      NODE_ENV: production
      DATABASE_URL: "postgresql://odoo_connector:<same-password>@db:5432/odoo_connector?schema=public"
      SHOPIFY_API_KEY: "<client id from Partner Dashboard>"
      SHOPIFY_API_SECRET: "<client secret - never commit this>"
      SCOPES: "write_products,read_customers,read_orders,read_inventory,write_inventory,read_locations,read_markets_home,write_metaobjects,write_metaobject_definitions"
      SHOPIFY_APP_URL: "https://<your-domain>"
    depends_on:
      - db

volumes:
  pgdata:
```

`docker-compose.yml` isn't committed to the repo (it holds secrets
inline here for simplicity) - keep it only on the server, or move the
`environment:` values into a separate `.env` file next to it (Compose
reads `.env` automatically) and `.gitignore` that instead.

If this server already runs Postgres for something else (e.g. the same
box hosting Odoo), it's fine to reuse that instance instead of the `db`
container above - just point `DATABASE_URL` at it and create a
dedicated database/user for this app rather than sharing one.

## 4. Build and start

```bash
docker compose up -d --build
docker compose logs -f app   # watch it boot; Ctrl+C to stop watching (app keeps running)
```

`npm run docker-start` (the Dockerfile's entrypoint) runs
`prisma migrate deploy` automatically on boot, so the database schema
is created on first start with no separate migration step.

## 5. Put nginx + HTTPS in front of it

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/odoo-connector`:

```nginx
server {
    listen 80;
    server_name <your-domain>;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/odoo-connector /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Get a free TLS certificate and auto-configure the HTTPS server block:
sudo certbot --nginx -d <your-domain>
```

Certbot rewrites the nginx config to redirect 80→443 and sets up
auto-renewal - no further TLS maintenance needed.

## 6. Point the Shopify app config at the real URL

```toml
# shopify.app.toml
application_url = "https://<your-domain>"

[auth]
redirect_urls = [ "https://<your-domain>/api/auth" ]
```

```bash
npm run deploy   # runs `shopify app deploy`, pushes this config to Shopify
```

## 7. Verify

- `https://<your-domain>` loads without a certificate warning.
- Install on a development store, confirm the Odoo Connection page
  loads and a test connection succeeds.
- `docker compose logs -f app` shows periodic `Inventory pull`
  sync events - confirms the background poller survived the deploy and
  reboot-safe restart policy (`restart: unless-stopped`).

## Ongoing maintenance this approach takes on (vs. a managed platform)

- **OS/security patching** of the server itself - a managed platform
  handles this; here it's this server's existing maintenance routine.
- **Certificate renewal** - automatic via certbot's own systemd timer,
  but worth confirming it's actually enabled (`sudo systemctl status
  certbot.timer`).
- **Deploying updates** - `git pull && docker compose up -d --build`
  rebuilds and restarts with zero extra tooling, but it's a manual step
  someone has to remember to run (no auto-deploy-on-push here unless
  that's set up separately).
