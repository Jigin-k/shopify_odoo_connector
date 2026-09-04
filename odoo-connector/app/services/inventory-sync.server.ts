import crypto from "node:crypto";

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { OdooClient } from "./odoo/client.server";
import { setShopifyInventoryLevels, type StockRow } from "./shopify/inventory.server";

const DEFAULT_INTERVAL_MS = 90_000;

// Odoo stores/compares datetimes as naive UTC and rejects a timezone
// suffix outright (confirmed against the real server: a plain
// `.toISOString()` value - which always ends in "Z" - errors with
// "expecting only datetimes with no timezone"). JS Dates are UTC
// internally regardless of suffix, so just dropping the "Z" gives
// exactly the naive-UTC string Odoo expects, not a lossy conversion.
function toOdooDatetime(date: Date) {
  return date.toISOString().replace("Z", "");
}

type OdooSnapshotRow = {
  shopify_location_id: string;
  shopify_variant_id: string;
  sku: string | null;
  available: number;
};

/*
 * One poll tick for one shop: pull whatever changed in Odoo since the
 * last successful pull (see product.product.shopify_stock_snapshot's own
 * docstring for why `updated_since` only narrows *which* variants are
 * reported, never the correctness of their totals), push it to Shopify,
 * then move the cursor forward - only past a tick that actually
 * succeeded, so a failed push gets retried on the next tick rather than
 * silently skipped.
 */
async function pollShopInventory(connection: {
  shop: string;
  odooUrl: string;
  database: string;
  apiKey: string;
  lastInventorySyncAt: Date | null;
}) {
  const odoo = new OdooClient({
    url: connection.odooUrl,
    database: connection.database,
    apiKey: connection.apiKey,
  });

  const tickStartedAt = new Date();
  const rows = await odoo.call<OdooSnapshotRow[]>("product.product", "shopify_stock_snapshot", {
    shopify_shop: connection.shop,
    updated_since: connection.lastInventorySyncAt
      ? toOdooDatetime(connection.lastInventorySyncAt)
      : undefined,
  });

  if (rows.length === 0) {
    await prisma.odooConnection.update({
      where: { shop: connection.shop },
      data: { lastInventorySyncAt: tickStartedAt },
    });
    return { pushed: 0 };
  }

  const stockRows: StockRow[] = rows.map((row) => ({
    shopifyLocationId: row.shopify_location_id,
    shopifyVariantId: row.shopify_variant_id,
    available: row.available,
  }));

  const { admin } = await unauthenticated.admin(connection.shop);
  const { updated } = await setShopifyInventoryLevels(admin, stockRows);

  await prisma.odooConnection.update({
    where: { shop: connection.shop },
    data: { lastInventorySyncAt: tickStartedAt },
  });

  return { pushed: updated };
}

/*
 * Runs one poll tick across every connected, active shop. Each shop is
 * handled independently and logged independently (via SyncEvent, same
 * place webhook activity is recorded) - one shop's Odoo being briefly
 * unreachable must never stop the rest from syncing.
 */
export async function pollAllShopsInventory() {
  const connections = await prisma.odooConnection.findMany({ where: { active: true } });

  for (const connection of connections) {
    const event = await prisma.syncEvent.create({
      data: {
        webhookId: crypto.randomUUID(),
        shop: connection.shop,
        topic: "inventory:pull",
      },
    });

    try {
      const { pushed } = await pollShopInventory(connection);
      await prisma.syncEvent.update({
        where: { id: event.id },
        data: {
          status: "COMPLETED",
          processedAt: new Date(),
          resourceId: `${pushed} variant(s)`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown inventory sync error";
      console.error(`Inventory pull failed for ${connection.shop}:`, error);
      await prisma.syncEvent.update({
        where: { id: event.id },
        data: { status: "FAILED", error: message.slice(0, 2000) },
      });
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var inventoryPollerInterval: NodeJS.Timeout | undefined;
}

/*
 * Starts the recurring poll, guarded the same way db.server.ts guards
 * its Prisma client: a global survives Vite's dev-mode module reloads,
 * so restarting this module (HMR) never stacks up a second interval
 * running alongside the first.
 */
export function startInventoryPoller() {
  if (global.inventoryPollerInterval) return;

  const intervalMs = Number(process.env.INVENTORY_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  global.inventoryPollerInterval = setInterval(() => {
    pollAllShopsInventory().catch((error) => {
      console.error("Inventory poller tick failed:", error);
    });
  }, intervalMs);

  // Node's default event loop keep-alive would otherwise hold the
  // process open on this timer alone during a graceful shutdown.
  global.inventoryPollerInterval.unref?.();
}
