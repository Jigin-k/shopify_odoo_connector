import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/*
 * Mandatory Shopify compliance webhook - required on every App Store app
 * regardless of whether it stores customer data. Shopify sends this when
 * a customer requests a copy of the data a store (and its apps) hold
 * about them.
 *
 * This app itself stores no customer PII: SyncMapping only keeps the
 * (shop, Shopify ID, Odoo ID) pairing, and SyncEvent only logs a Shopify
 * resource ID, neither an email/name/address. The actual customer record
 * lives in the merchant's own Odoo (res.partner), which the merchant
 * already controls directly - there is nothing for this app's own
 * infrastructure to hand over. We log the request for an audit trail and
 * acknowledge it; fulfilling the data export itself is the merchant's
 * responsibility via their Odoo instance.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customer = (payload as { customer?: { id?: number | string } }).customer;

  await db.syncEvent.create({
    data: {
      webhookId: crypto.randomUUID(),
      shop,
      topic: "customers/data_request",
      resourceId: customer?.id != null ? String(customer.id) : null,
      status: "COMPLETED",
      processedAt: new Date(),
    },
  });

  return new Response();
};
