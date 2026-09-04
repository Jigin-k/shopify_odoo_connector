import { OdooClient } from "./client.server";
import { saveMapping } from "./sync.server";

export type ShopifyVariantForOdoo = {
  shopifyVariantId?: string | null;
  sku: string | null;
  price: string;
  // Shopify's own variant title ("Small", "Small / Red", ...) - doubles
  // as the label for the generic "Shopify Variant" attribute value Odoo
  // creates per variant (see product.template.shopify_sync_product's
  // docstring on the Odoo side for why one generic attribute rather than
  // real per-option Size/Color attributes).
  title?: string | null;
  weight?: number | null;
  cost?: number | null;
};

export type ShopifyProductForOdoo = {
  title: string;
  sku: string | null;
  price: string;
  description?: string | null;
  // Base64-encoded image bytes (no data: URI prefix) - Odoo's
  // image_1920 field expects the raw base64 payload directly.
  imageBase64?: string | null;
  // The primary/first variant's Shopify ID (GID form) - used only when
  // `variants` has exactly one entry (or is omitted); see
  // ShopifyProductForOdoo.variants below for the multi-variant case.
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
  // The product's *entire* variant list. One entry is the common case
  // (most Shopify products); more than one triggers Odoo-side attribute/
  // variant generation so every Shopify variant - not just the first -
  // lands in the Odoo catalog. Falls back to the single shopifyVariantId/
  // sku/price fields above when omitted, for callers that only ever
  // knew about one variant.
  variants?: ShopifyVariantForOdoo[];
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

  const variants = (product.variants && product.variants.length > 0
    ? product.variants
    : undefined
  )?.map((variant) => ({
    shopify_variant_id: variant.shopifyVariantId || undefined,
    sku: variant.sku || undefined,
    price: variant.price != null ? Number(variant.price || 0) : undefined,
    title: variant.title || undefined,
    weight: variant.weight ?? undefined,
    cost: variant.cost ?? undefined,
  }));

  const result = await odoo.call<OdooSyncResult>("product.template", "shopify_sync_product", {
    vals: {
      shopify_shop: identity.shop,
      shopify_id: identity.shopifyId,
      name: product.title,
      list_price: Number(product.price || 0),
      default_code: sku || shopifyReference,
      shopify_variant_id: product.shopifyVariantId || undefined,
      description_sale: product.description || undefined,
      image_1920: product.imageBase64 || undefined,
      type,
      is_storable: isStorable,
      variants,
    },
  });

  await saveMapping(identity.shop, "product", identity.shopifyId, result.model, result.id);

  return { action: result.action, odooProductId: result.id };
}

/*
 * Downloads a Shopify product image and returns it as bare base64 (no
 * data: URI prefix) - what Odoo's image_1920 field expects directly.
 * Best-effort: a slow/unreachable CDN fetch must never fail the whole
 * product sync over a missing picture, so this swallows errors and
 * returns null rather than throwing.
 */
export async function fetchImageAsBase64(url: string | null | undefined) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes).toString("base64");
  } catch (error) {
    console.error("Failed to fetch product image for Odoo sync:", error);
    return null;
  }
}

export async function archiveProductInOdoo(odoo: OdooClient, shop: string, shopifyId: string) {
  return odoo.call("product.template", "shopify_archive_product", {
    shopify_shop: shop,
    shopify_id: shopifyId,
  });
}
