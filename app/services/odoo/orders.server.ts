import { OdooClient } from "./client.server";
import { toOdooCustomerVals, type ShopifyCustomerForOdoo } from "./customers.server";
import { saveMapping } from "./sync.server";

export type ShopifyOrderForOdoo = {
  id: string;
  name: string;
  email?: string | null;
  currency: string;
  financialStatus?: string | null;
  cancelledAt?: string | null;
  // Whether line prices already include tax - Shopify's own per-order
  // setting. Odoo needs this to know whether a mapped tax should be
  // marked Tax Included, or it'll compute the wrong subtotal/total even
  // with the right tax rate assigned.
  taxesIncluded?: boolean;
  // Shopify's own order note, tags, and fulfillment status - purely
  // informational fields carried across for visibility in Odoo, none of
  // them drive any workflow logic there.
  note?: string | null;
  tags?: string | null;
  fulfillmentStatus?: string | null;
  customer?: ShopifyCustomerForOdoo | null;
  shippingAddress?: ShopifyCustomerForOdoo["address"];
  lineItems: Array<{
    title: string;
    sku?: string | null;
    // See webhooks.server.ts - without this, a line whose variant has no
    // SKU has no stable identity and gets duplicated on every re-sync.
    shopifyVariantId?: string | null;
    quantity: number;
    price: string;
    // Without this, Odoo has no way to know what tax Shopify actually
    // charged and falls back to the product's own default tax, applying
    // it on top of a price that's already final - inflating the Odoo
    // total above what Shopify collected.
    taxLines?: Array<{ title: string; rate: number }>;
  }>;
};

type OdooSyncResult = {
  action: "created" | "updated";
  id: number;
  model: string;
};

/*
 * One Odoo call does the whole order: shopify_connector's
 * sale.order.shopify_sync_order() syncs the customer, resolves or
 * creates every line's product, writes/creates the order and runs
 * action_confirm/action_cancel - all inside one Odoo transaction. That
 * replaces what used to be a customer call, one product lookup/create
 * call per line, an order call and a workflow call (12+ round trips for
 * a 10-line order) with a single round trip.
 */
export async function syncOrderToOdoo(
  shop: string,
  odoo: OdooClient,
  order: ShopifyOrderForOdoo,
) {
  const customer = order.customer ?? {
    id: `guest:${order.id}`,
    email: order.email,
    address: order.shippingAddress,
  };

  const result = await odoo.call<OdooSyncResult>("sale.order", "shopify_sync_order", {
    vals: {
      shopify_shop: shop,
      shopify_id: order.id,
      name: order.name,
      customer: toOdooCustomerVals(shop, customer),
      taxes_included: Boolean(order.taxesIncluded),
      lines: order.lineItems.map((line) => ({
        title: line.title,
        sku: line.sku || undefined,
        shopify_variant_id: line.shopifyVariantId || undefined,
        quantity: line.quantity,
        price: Number(line.price || 0),
        tax_lines: (line.taxLines || []).map((taxLine) => ({
          title: taxLine.title,
          rate: taxLine.rate,
        })),
      })),
      financial_status: order.financialStatus || undefined,
      cancelled: Boolean(order.cancelledAt),
      // Identity (Shopify order ID, currency) is already fully covered
      // by shopify_id/shopify_shop/origin on the Odoo side - this field
      // is free to carry the real Shopify order note instead of a
      // synthetic identity string.
      note: order.note || undefined,
      tags: order.tags || undefined,
      fulfillment_status: order.fulfillmentStatus || undefined,
    },
  });

  await saveMapping(shop, "order", order.id, result.model, result.id);

  return result.id;
}
