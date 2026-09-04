import { unauthenticated } from "../../shopify.server";

type AdminApiContext = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

export type StockRow = {
  shopifyLocationId: string;
  shopifyVariantId: string;
  available: number;
};

type InventoryItemLookup = {
  data?: { nodes: Array<{ id: string; inventoryItem: { id: string } } | null> };
  errors?: Array<{ message: string }>;
};

type InventorySetResult = {
  data?: {
    inventorySetQuantities: {
      userErrors: Array<{ message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
};

// Shopify's node-lookup and mutation batch sizes both comfortably fit
// well more than this in one call; kept modest so one slow/huge poll
// tick can't build an oversized single request.
const BATCH_SIZE = 100;

/*
 * Odoo only knows a variant's own Shopify ID (tagged when the variant
 * was first synced) - the inventory mutation needs its *inventory item*
 * ID instead. Resolving many at once here, rather than one query per
 * variant, is what makes pulling a whole catalog's stock levels on a
 * timer practical instead of one round trip per item.
 */
async function resolveInventoryItemIds(admin: AdminApiContext, variantIds: string[]) {
  const response = await admin.graphql(
    `#graphql
      query OdooConnectorInventoryItems($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem { id }
          }
        }
      }
    `,
    { variables: { ids: variantIds } },
  );
  const json = (await response.json()) as InventoryItemLookup;
  if (!json.data) {
    throw new Error(json.errors?.[0]?.message || "Shopify variant lookup failed.");
  }

  const map = new Map<string, string>();
  for (const node of json.data.nodes) {
    if (node?.id && node.inventoryItem?.id) {
      map.set(node.id, node.inventoryItem.id);
    }
  }
  return map;
}

/*
 * Sets the absolute "available" quantity Odoo reports for each row's
 * variant at its location - always a set, never a delta, since Odoo is
 * inventory's source of truth (see the Odoo module's shopify_stock_
 * snapshot docstring): ignoreCompareQuantity skips Shopify's optimistic-
 * concurrency check, which is what we want when Odoo's number should
 * always win.
 */
export async function setShopifyInventoryLevels(admin: AdminApiContext, rows: StockRow[]) {
  let updated = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const variantIds = [...new Set(chunk.map((row) => row.shopifyVariantId))];
    const itemIdByVariant = await resolveInventoryItemIds(admin, variantIds);

    const quantities = chunk.flatMap((row) => {
      const inventoryItemId = itemIdByVariant.get(row.shopifyVariantId);
      if (!inventoryItemId) return [];
      return [
        {
          inventoryItemId,
          locationId: row.shopifyLocationId,
          quantity: Math.max(0, Math.trunc(row.available)),
        },
      ];
    });
    if (quantities.length === 0) continue;

    const response = await admin.graphql(
      `#graphql
        mutation OdooConnectorSetInventoryBatch($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            userErrors { message }
          }
        }
      `,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities,
          },
        },
      },
    );
    const json = (await response.json()) as InventorySetResult;
    const userErrors = json.data?.inventorySetQuantities.userErrors || [];
    if (userErrors.length) {
      throw new Error(userErrors.map((error) => error.message).join("; "));
    }
    if (!json.data) {
      throw new Error(json.errors?.[0]?.message || "Shopify inventorySetQuantities failed.");
    }

    updated += quantities.length;
  }

  return { updated };
}
