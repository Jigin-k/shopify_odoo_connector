import { OdooClient } from "./client.server";
import { saveMapping } from "./sync.server";

export type ShopifyProductForOdoo = {
  title: string;
  sku: string | null;
  price: string;
  // The primary/first variant's Shopify ID (GID form). Tagging it on the
  // Odoo variant here is what lets an order line for this same product -
  // synced separately, possibly before this catalog sync ever runs - be
  // matched by ID instead of falling back to (or missing) a SKU match.
  shopifyVariantId?: string | null;
  // Whether the variant needs shipping (Shopify's InventoryItem.
  // requiresShipping / REST requires_shipping) and whether Shopify is
  // tracking its quantity (InventoryItem.tracked / REST
  // inventory_management === "shopify"). Together these decide the
  // Odoo product's type and Track Inventory flag below - without them,
  // every synced product defaulted to a generic trackable good
  // regardless of what it actually was in Shopify.
  requiresShipping: boolean;
  tracked: boolean;
};

type OdooSyncResult = {
  action: "created" | "updated";
  id: number;
  model: string;
};

/*
 * Maps Shopify's shipping/tracking flags onto Odoo's product type:
 * - Doesn't require shipping -> a service (a digital good, a fee, a
 *   gift card) - Odoo has no stock concept for these at all.
 * - Requires shipping -> a physical good ("consu" - Goods, in Odoo
 *   19's terms), Track Inventory following whatever Shopify itself is
 *   tracking for that variant.
 */
function toOdooProductType(product: Pick<ShopifyProductForOdoo, "requiresShipping" | "tracked">) {
  if (!product.requiresShipping) {
    return { type: "service", isStorable: false };
  }
  return { type: "consu", isStorable: product.tracked };
}

/*
 * Upsert a product in one Odoo call: shopify_connector's
 * product.template.shopify_sync_product() finds the record by
 * shopify_id (falling back to default_code/SKU for a never-before-seen
 * ID) and writes or creates it, all inside Odoo's own transaction.
 */
export async function syncProductToOdoo(
  odoo: OdooClient,
  product: ShopifyProductForOdoo,
  identity: { shop: string; shopifyId: string },
) {
  const sku = product.sku?.trim() || "";
  const shopifyReference = `SHOPIFY-${identity.shopifyId.split("/").pop()}`;
  const { type, isStorable } = toOdooProductType(product);

  const result = await odoo.call<OdooSyncResult>("product.template", "shopify_sync_product", {
    vals: {
      shopify_shop: identity.shop,
      shopify_id: identity.shopifyId,
      name: product.title,
      list_price: Number(product.price || 0),
      default_code: sku || shopifyReference,
      shopify_variant_id: product.shopifyVariantId || undefined,
      type,
      is_storable: isStorable,
    },
  });

  await saveMapping(identity.shop, "product", identity.shopifyId, result.model, result.id);

  return { action: result.action, odooProductId: result.id };
}

export async function archiveProductInOdoo(odoo: OdooClient, shop: string, shopifyId: string) {
  return odoo.call("product.template", "shopify_archive_product", {
    shopify_shop: shop,
    shopify_id: shopifyId,
  });
}
