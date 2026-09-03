import { OdooClient } from "./client.server";
import { saveMapping } from "./sync.server";

export type ShopifyCustomerForOdoo = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    zip?: string | null;
    country?: string | null;
  } | null;
};

type OdooSyncResult = {
  action: "created" | "updated";
  id: number;
  model: string;
};

/*
 * Shared with orders.server.ts, which embeds this same shape as the
 * "customer" key of a shopify_sync_order() call - keeping it here means
 * the name-fallback rule only lives in one place.
 */
export function toOdooCustomerVals(shop: string, customer: ShopifyCustomerForOdoo) {
  const name =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    customer.email ||
    `Shopify customer ${customer.id}`;

  return {
    shopify_shop: shop,
    shopify_id: customer.id,
    name,
    email: customer.email || false,
    phone: customer.phone || false,
    street: customer.address?.address1 || false,
    street2: customer.address?.address2 || false,
    city: customer.address?.city || false,
    zip: customer.address?.zip || false,
    comment: `Synchronized from Shopify (${customer.id})`,
  };
}

export async function syncCustomerToOdoo(
  shop: string,
  odoo: OdooClient,
  customer: ShopifyCustomerForOdoo,
) {
  const result = await odoo.call<OdooSyncResult>("res.partner", "shopify_sync_customer", {
    vals: toOdooCustomerVals(shop, customer),
  });

  await saveMapping(shop, "customer", customer.id, result.model, result.id);

  return result.id;
}

export async function archiveCustomerInOdoo(odoo: OdooClient, shop: string, shopifyId: string) {
  return odoo.call("res.partner", "shopify_archive_customer", {
    shopify_shop: shop,
    shopify_id: shopifyId,
  });
}
