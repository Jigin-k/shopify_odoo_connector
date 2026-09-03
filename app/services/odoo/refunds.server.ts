import { OdooClient } from "./client.server";

export type ShopifyRefundForOdoo = {
  id: string;
  orderId: string;
  lines: Array<{
    shopifyVariantId?: string | null;
    sku?: string | null;
    title: string;
    quantity: number;
  }>;
};

/*
 * One Odoo call creates the credit note - matching each refunded line
 * back to the original sale.order.line's exact product/price/tax (see
 * sale.order.shopify_sync_refund's docstring), posting it, and
 * registering the refund payment. Idempotent via shopify_refund_id, so
 * a redelivered refunds/create webhook is a safe no-op, not a duplicate
 * credit note.
 */
export async function syncRefundToOdoo(
  shop: string,
  odoo: OdooClient,
  refund: ShopifyRefundForOdoo,
) {
  return odoo.call("sale.order", "shopify_sync_refund", {
    vals: {
      shopify_shop: shop,
      shopify_order_id: refund.orderId,
      shopify_refund_id: refund.id,
      lines: refund.lines.map((line) => ({
        shopify_variant_id: line.shopifyVariantId || undefined,
        sku: line.sku || undefined,
        title: line.title,
        quantity: line.quantity,
      })),
    },
  });
}
