import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/*
 * Mandatory Shopify compliance webhook - sent ~10 days after a customer's
 * erasure request is approved, instructing the app to delete that
 * customer's personal data from its own systems.
 *
 * This app's own database (Prisma) holds no customer PII to begin with -
 * SyncMapping only pairs a Shopify ID with an Odoo ID, so the only thing
 * to remove here is that pairing, not any personal data. The actual
 * customer record (name, email, address) lives in the merchant's own
 * Odoo as a res.partner - the merchant's own business/accounting system,
 * which this app does not reach into destructively on an automated
 * webhook (a customer record there may be tied to real invoices/
 * accounting entries; erasing it is the merchant's call to make in
 * Odoo directly, same as if they'd entered that contact by hand).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customer = (payload as { customer?: { id?: number | string } }).customer;
  const shopifyId = customer?.id != null ? String(customer.id) : null;

  if (shopifyId) {
    await db.syncMapping.deleteMany({
      where: { shop, resourceType: "customer", shopifyId },
    });
  }

  await db.syncEvent.create({
    data: {
      webhookId: crypto.randomUUID(),
      shop,
      topic: "customers/redact",
      resourceId: shopifyId,
      status: "COMPLETED",
      processedAt: new Date(),
    },
  });

  return new Response();
};
