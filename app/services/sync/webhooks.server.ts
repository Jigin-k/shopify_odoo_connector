import prisma from "../../db.server";
import { archiveCustomerInOdoo, syncCustomerToOdoo } from "../odoo/customers.server";
import { syncOrderToOdoo } from "../odoo/orders.server";
import {
  archiveProductInOdoo,
  fetchImageAsBase64,
  syncProductToOdoo,
  type ShopifyVariantForOdoo,
} from "../odoo/products.server";
import { syncRefundToOdoo } from "../odoo/refunds.server";
import { getOdooClient, numericShopifyId } from "../odoo/sync.server";

// REST payload weight units ("g", "kg", "oz", "lb") - same conversion
// need as the GraphQL path (app.products.tsx), just REST's own unit
// strings instead of GraphQL's enum values.
const REST_WEIGHT_TO_KG: Record<string, number> = {
  g: 0.001,
  kg: 1,
  oz: 0.0283495,
  lb: 0.453592,
};

type WebhookPayload = Record<string, unknown>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return value == null ? null : String(value);
}

// REST webhook payloads reference nested resources (a line item's variant,
// a product's variants) by bare numeric id, never a GID - construct the
// same gid://shopify/... form the GraphQL Admin API returns natively, so
// a variant tagged via one sync path (product webhook, manual /app/products
// sync, an order line) is always found by the others.
function variantGid(value: unknown) {
  return value == null ? null : `gid://shopify/ProductVariant/${value}`;
}

// refunds/create's own "order_id" field is a bare numeric id too, unlike
// its "admin_graphql_api_id" (which identifies the refund, not the order).
function orderGid(value: unknown) {
  return value == null ? null : `gid://shopify/Order/${value}`;
}

function address(value: unknown) {
  const item = object(value);
  if (!item) return null;
  return {
    address1: text(item.address1),
    address2: text(item.address2),
    city: text(item.city),
    province: text(item.province),
    zip: text(item.zip),
    country: text(item.country),
  };
}

function customer(payload: Record<string, unknown>) {
  return {
    id: numericShopifyId(payload.admin_graphql_api_id || payload.id),
    firstName: text(payload.first_name),
    lastName: text(payload.last_name),
    email: text(payload.email),
    phone: text(payload.phone),
    address: address(payload.default_address),
  };
}

export async function processShopifyWebhook(
  shop: string,
  topic: string,
  payload: WebhookPayload,
) {
  const normalizedTopic = topic.toUpperCase();
  const shopifyId = numericShopifyId(
    payload.admin_graphql_api_id || payload.id,
  );
  // Every remaining topic needs Odoo, and shopify_connector's own
  // shopify_archive_* methods look records up by shopify_id themselves -
  // no local mapping lookup needed before archiving anymore.
  const odoo = await getOdooClient(shop);

  if (normalizedTopic === "PRODUCTS_DELETE") {
    return archiveProductInOdoo(odoo, shop, shopifyId);
  }
  if (normalizedTopic === "CUSTOMERS_DELETE") {
    return archiveCustomerInOdoo(odoo, shop, shopifyId);
  }

  if (["PRODUCTS_CREATE", "PRODUCTS_UPDATE"].includes(normalizedTopic)) {
    const rawVariants = Array.isArray(payload.variants) ? payload.variants : [];
    const firstVariant = object(rawVariants[0]) ?? {};
    const variants: ShopifyVariantForOdoo[] = rawVariants.map((value) => {
      const variant = object(value) ?? {};
      const weightUnit = text(variant.weight_unit) || "kg";
      const weight = Number(variant.weight);
      return {
        shopifyVariantId: variantGid(variant.id),
        sku: text(variant.sku),
        price: text(variant.price) || "0",
        title: text(variant.title),
        weight: Number.isFinite(weight) && weight > 0
          ? weight * (REST_WEIGHT_TO_KG[weightUnit] ?? 1)
          : null,
        // REST's product webhook payload doesn't embed per-variant cost
        // (unlike GraphQL's InventoryItem.unitCost) - would need a
        // separate InventoryItem lookup per variant, which is a
        // disproportionate cost for a passive webhook handler. Cost only
        // syncs via the manual/bulk sync paths in /app/products, which
        // already fetch it through GraphQL.
        cost: null,
      };
    });
    const imageUrl = text(object(payload.image)?.src);
    const imageBase64 = await fetchImageAsBase64(imageUrl);
    return syncProductToOdoo(
      odoo,
      {
        title: text(payload.title) || `Shopify product ${shopifyId}`,
        sku: text(firstVariant.sku),
        price: text(firstVariant.price) || "0",
        description: text(payload.body_html),
        imageBase64,
        // REST webhooks give nested resources a bare numeric id, unlike
        // the GraphQL-sourced GIDs the manual /app/products sync uses -
        // normalize to the same gid:// form so both paths tag the same
        // Odoo variant and order-line resolution can find it either way.
        shopifyVariantId: variantGid(firstVariant.id),
        // REST defaults this field to true for physical products; only
        // an explicit false (digital goods, gift cards, services) should
        // count as "doesn't require shipping".
        requiresShipping: firstVariant.requires_shipping !== false,
        tracked: firstVariant.inventory_management === "shopify",
        variants,
      },
      { shop, shopifyId },
    );
  }

  if (["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE"].includes(normalizedTopic)) {
    return syncCustomerToOdoo(shop, odoo, customer(payload));
  }

  if (
    [
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_PAID",
      "ORDERS_CANCELLED",
    ].includes(normalizedTopic)
  ) {
    const customerPayload = object(payload.customer);
    const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
    return syncOrderToOdoo(shop, odoo, {
      id: shopifyId,
      name: text(payload.name) || text(payload.order_number) || shopifyId,
      email: text(payload.email),
      currency: text(payload.currency) || "",
      financialStatus: text(payload.financial_status),
      cancelledAt: text(payload.cancelled_at),
      taxesIncluded: Boolean(payload.taxes_included),
      note: text(payload.note),
      tags: text(payload.tags),
      fulfillmentStatus: text(payload.fulfillment_status),
      customer: customerPayload ? customer(customerPayload) : null,
      shippingAddress: address(payload.shipping_address),
      lineItems: lines.map((value) => {
        const line = object(value) ?? {};
        const taxLines = Array.isArray(line.tax_lines) ? line.tax_lines : [];
        return {
          title: text(line.title) || "Shopify order item",
          sku: text(line.sku),
          // Without this, a line item for a variant with no SKU set
          // (common - Shopify doesn't require one) has no identity at
          // all: Odoo's product resolver falls through to creating a
          // brand-new product on every single sync, and since orders
          // /create, /updated and /paid all re-run the full sync, one
          // order can end up with the same line duplicated 3+ times.
          shopifyVariantId: variantGid(line.variant_id),
          quantity: Number(line.quantity || 0),
          price: text(line.price) || "0",
          taxLines: taxLines.map((value) => {
            const taxLine = object(value) ?? {};
            return {
              title: text(taxLine.title) || "Tax",
              rate: Number(taxLine.rate || 0),
            };
          }),
        };
      }),
    });
  }

  if (normalizedTopic === "REFUNDS_CREATE") {
    const lines = Array.isArray(payload.refund_line_items) ? payload.refund_line_items : [];
    return syncRefundToOdoo(shop, odoo, {
      id: shopifyId,
      orderId: orderGid(payload.order_id) || "",
      lines: lines.map((value) => {
        const refundLine = object(value) ?? {};
        // The refund webhook embeds the original line item's own
        // product/variant/sku right on each refund_line_items entry -
        // no need to look anything up on the order itself.
        const lineItem = object(refundLine.line_item) ?? {};
        return {
          shopifyVariantId: variantGid(lineItem.variant_id),
          sku: text(lineItem.sku),
          title: text(lineItem.title) || "Refunded item",
          quantity: Number(refundLine.quantity || 0),
        };
      }),
    });
  }

  throw new Error(`Unsupported Shopify webhook topic: ${topic}`);
}

export async function recordAndProcessWebhook(input: {
  webhookId: string;
  shop: string;
  topic: string;
  payload: WebhookPayload;
}) {
  const existing = await prisma.syncEvent.findUnique({
    where: { webhookId: input.webhookId },
  });
  if (existing?.status === "COMPLETED" || existing?.status === "PROCESSING") {
    return existing;
  }

  const resourceId = numericShopifyId(
    input.payload.admin_graphql_api_id || input.payload.id,
  );
  const event = existing
    ? await prisma.syncEvent.update({
        where: { id: existing.id },
        data: { status: "PROCESSING", error: null },
      })
    : await prisma.syncEvent.create({
        data: {
          webhookId: input.webhookId,
          shop: input.shop,
          topic: input.topic,
          resourceId: resourceId || null,
        },
      });

  try {
    await processShopifyWebhook(input.shop, input.topic, input.payload);
    return prisma.syncEvent.update({
      where: { id: event.id },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    await prisma.syncEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", error: message.slice(0, 2000) },
    });
    throw error;
  }
}
