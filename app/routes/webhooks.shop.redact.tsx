import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/*
 * Mandatory Shopify compliance webhook - sent 48 hours after a shop
 * uninstalls (if it hasn't reinstalled), as the final signal to erase
 * all of that shop's data from the app's own systems.
 *
 * webhooks.app.uninstalled.tsx already wipes this app's shop-scoped rows
 * immediately on uninstall, so by the time this arrives there is usually
 * nothing left - this is the idempotent safety net for the mandatory
 * webhook set (a shop that reinstalled and uninstalled again quickly,
 * or any row the uninstall handler missed).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.syncMapping.deleteMany({ where: { shop } }),
    db.syncEvent.deleteMany({ where: { shop } }),
    db.odooConnection.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
