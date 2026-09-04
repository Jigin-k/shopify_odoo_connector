import prisma from "../../db.server";
import { OdooClient } from "./client.server";

export type SyncResourceType = "product" | "customer" | "order";

export async function getOdooClient(shop: string) {
  const connection = await prisma.odooConnection.findUnique({ where: { shop } });

  if (!connection?.active) {
    throw new Error("Odoo is not connected or the connection is inactive.");
  }

  return new OdooClient({
    url: connection.odooUrl,
    database: connection.database,
    apiKey: connection.apiKey,
  });
}

/*
 * Odoo is now the source of truth for shop <-> record identity: the
 * shopify_connector module keeps shopify_id/shopify_shop fields directly
 * on product.template, res.partner and sale.order, and its
 * shopify_sync_* methods do their own find-or-create by those fields.
 *
 * This local table is kept only as a fast display cache so pages like
 * /app/products can show a "Synced #123" badge without a round trip to
 * Odoo per row - it is never consulted to decide create-vs-update
 * anymore, so a stale or missing row here can no longer cause a
 * duplicate Odoo record.
 */
export async function saveMapping(
  shop: string,
  resourceType: SyncResourceType,
  shopifyId: string,
  odooModel: string,
  odooId: number,
) {
  return prisma.syncMapping.upsert({
    where: {
      shop_resourceType_shopifyId: { shop, resourceType, shopifyId },
    },
    update: { odooModel, odooId },
    create: { shop, resourceType, shopifyId, odooModel, odooId },
  });
}

export function numericShopifyId(id: unknown) {
  return String(id ?? "");
}
