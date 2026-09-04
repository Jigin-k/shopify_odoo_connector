import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { getOdooClient } from "../odoo/sync.server";
import {
  archiveCustomerInOdoo,
  syncCustomerToOdoo,
} from "../odoo/customers.server";
import { syncOrderToOdoo } from "../odoo/orders.server";
import {
  archiveProductInOdoo,
  fetchImageAsBase64,
  syncProductToOdoo,
  type ShopifyVariantForOdoo,
} from "../odoo/products.server";

type AdminApiContext = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

// A permanently-broken event (bad payload, a resource Shopify itself
// has since deleted) must not retry forever - after this many attempts
// it's left FAILED for good, for a human to look at.
const MAX_RETRIES = 5;
// One tick's worth of work, across every shop combined - keeps a bad
// pile-up from turning one retry tick into an unbounded loop.
const BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 10 * 60_000; // 10 minutes - failures don't need 90s cadence

/*
 * Shopify already retries a webhook delivery itself (with backoff, for
 * up to ~48 hours) when this app's own webhook route returns a 500 - so
 * this job is a slower safety net for what that doesn't cover: an outage
 * longer than Shopify's own retry window, and any bulk "Sync all" click
 * from the UI, which was never a webhook delivery Shopify could retry at
 * all.
 *
 * Rather than replaying the exact payload that failed (which isn't
 * stored - see SyncEvent's schema comment), this re-fetches the
 * resource's *current* state from Shopify and re-runs the same sync a
 * manual "Sync one" click would - arguably more correct anyway, since a
 * long-failed event's original payload may be stale by the time it's
 * finally retried.
 */
async function retryEvent(
  admin: AdminApiContext,
  shop: string,
  odoo: Awaited<ReturnType<typeof getOdooClient>>,
  topic: string,
  resourceId: string,
) {
  const normalizedTopic = topic.toUpperCase();

  if (normalizedTopic === "PRODUCTS_DELETE") {
    await archiveProductInOdoo(odoo, shop, resourceId);
    return;
  }
  if (normalizedTopic === "CUSTOMERS_DELETE") {
    await archiveCustomerInOdoo(odoo, shop, resourceId);
    return;
  }

  if (["PRODUCTS_CREATE", "PRODUCTS_UPDATE"].includes(normalizedTopic)) {
    const gid = `gid://shopify/Product/${resourceId}`;
    const response = await admin.graphql(
      `#graphql
        query OdooConnectorRetryProduct($id: ID!) {
          product(id: $id) {
            id title descriptionHtml
            featuredMedia { ... on MediaImage { image { url } } }
            variants(first: 100) {
              nodes {
                id title sku price
                inventoryItem {
                  tracked requiresShipping
                  unitCost { amount }
                  measurement { weight { value unit } }
                }
              }
            }
          }
        }
      `,
      { variables: { id: gid } },
    );
    const json = (await response.json()) as {
      data?: {
        product: {
          id: string;
          title: string;
          descriptionHtml: string;
          featuredMedia: { image: { url: string } } | null;
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              sku: string | null;
              price: string;
              inventoryItem: {
                tracked: boolean;
                requiresShipping: boolean;
                unitCost: { amount: string } | null;
                measurement: { weight: { value: number; unit: string } | null };
              };
            }>;
          };
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    const product = json.data?.product;
    if (!product) {
      // The product no longer exists on Shopify - nothing left to sync.
      // Not an error worth retrying again.
      return;
    }
    const firstVariant = product.variants.nodes[0];
    if (!firstVariant) return;

    const weightToKg: Record<string, number> = {
      GRAMS: 0.001,
      KILOGRAMS: 1,
      OUNCES: 0.0283495,
      POUNDS: 0.453592,
    };
    const variants: ShopifyVariantForOdoo[] = product.variants.nodes.map((variant) => {
      const weightInfo = variant.inventoryItem.measurement.weight;
      return {
        shopifyVariantId: variant.id,
        sku: variant.sku,
        price: variant.price,
        title: variant.title,
        weight: weightInfo ? weightInfo.value * (weightToKg[weightInfo.unit] ?? 1) : null,
        cost: variant.inventoryItem.unitCost ? Number(variant.inventoryItem.unitCost.amount) : null,
      };
    });
    const imageBase64 = await fetchImageAsBase64(product.featuredMedia?.image.url);

    await syncProductToOdoo(
      odoo,
      {
        title: product.title,
        sku: firstVariant.sku,
        price: firstVariant.price,
        shopifyVariantId: firstVariant.id,
        description: product.descriptionHtml,
        imageBase64,
        requiresShipping: firstVariant.inventoryItem.requiresShipping,
        tracked: firstVariant.inventoryItem.tracked,
        variants,
      },
      { shop, shopifyId: product.id },
    );
    return;
  }

  if (["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE"].includes(normalizedTopic)) {
    const gid = `gid://shopify/Customer/${resourceId}`;
    const response = await admin.graphql(
      `#graphql
        query OdooConnectorRetryCustomer($id: ID!) {
          customer(id: $id) {
            id firstName lastName
            defaultEmailAddress { emailAddress }
            defaultPhoneNumber { phoneNumber }
            defaultAddress { address1 address2 city province zip country }
          }
        }
      `,
      { variables: { id: gid } },
    );
    const json = (await response.json()) as {
      data?: {
        customer: {
          id: string;
          firstName: string | null;
          lastName: string | null;
          defaultEmailAddress: { emailAddress: string } | null;
          defaultPhoneNumber: { phoneNumber: string } | null;
          defaultAddress: {
            address1: string | null;
            address2: string | null;
            city: string | null;
            province: string | null;
            zip: string | null;
            country: string | null;
          } | null;
        } | null;
      };
    };
    const customer = json.data?.customer;
    if (!customer) return;

    await syncCustomerToOdoo(shop, odoo, {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.defaultEmailAddress?.emailAddress,
      phone: customer.defaultPhoneNumber?.phoneNumber,
      address: customer.defaultAddress,
    });
    return;
  }

  if (
    ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_PAID", "ORDERS_CANCELLED"].includes(
      normalizedTopic,
    )
  ) {
    const gid = `gid://shopify/Order/${resourceId}`;
    const response = await admin.graphql(
      `#graphql
        query OdooConnectorRetryOrder($id: ID!) {
          order(id: $id) {
            id name email currencyCode cancelledAt
            displayFinancialStatus displayFulfillmentStatus
            taxesIncluded note tags
            customer {
              id firstName lastName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
              defaultAddress { address1 address2 city province zip country }
            }
            shippingAddress { address1 address2 city province zip country }
            lineItems(first: 100) {
              nodes {
                title quantity sku
                variant { id }
                taxLines { title rate }
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      `,
      { variables: { id: gid } },
    );
    type Address = {
      address1: string | null;
      address2: string | null;
      city: string | null;
      province: string | null;
      zip: string | null;
      country: string | null;
    };
    const json = (await response.json()) as {
      data?: {
        order: {
          id: string;
          name: string;
          email: string | null;
          currencyCode: string;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          taxesIncluded: boolean;
          note: string | null;
          tags: string[];
          fulfillmentStatus?: string;
          displayFulfillmentStatus: string | null;
          customer: {
            id: string;
            firstName: string | null;
            lastName: string | null;
            defaultEmailAddress: { emailAddress: string } | null;
            defaultPhoneNumber: { phoneNumber: string } | null;
            defaultAddress: Address | null;
          } | null;
          shippingAddress: Address | null;
          lineItems: {
            nodes: Array<{
              title: string;
              quantity: number;
              sku: string | null;
              variant: { id: string } | null;
              taxLines: Array<{ title: string; rate: number | null }>;
              originalUnitPriceSet: { shopMoney: { amount: string } };
            }>;
          };
        } | null;
      };
    };
    const order = json.data?.order;
    if (!order) return;

    await syncOrderToOdoo(shop, odoo, {
      id: order.id,
      name: order.name,
      email: order.email,
      currency: order.currencyCode,
      financialStatus: order.displayFinancialStatus,
      cancelledAt: order.cancelledAt,
      taxesIncluded: order.taxesIncluded,
      note: order.note,
      tags: order.tags.length > 0 ? order.tags.join(", ") : null,
      fulfillmentStatus: order.displayFulfillmentStatus,
      customer: order.customer
        ? {
            id: order.customer.id,
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
            email: order.customer.defaultEmailAddress?.emailAddress,
            phone: order.customer.defaultPhoneNumber?.phoneNumber,
            address: order.customer.defaultAddress,
          }
        : null,
      shippingAddress: order.shippingAddress,
      lineItems: order.lineItems.nodes.map((line) => ({
        title: line.title,
        sku: line.sku,
        shopifyVariantId: line.variant?.id ?? null,
        quantity: line.quantity,
        price: line.originalUnitPriceSet.shopMoney.amount,
        taxLines: line.taxLines.map((taxLine) => ({
          title: taxLine.title,
          rate: taxLine.rate ?? 0,
        })),
      })),
    });
    return;
  }

  // REFUNDS_CREATE and any other topic: not retryable automatically -
  // a refund has no standalone "refetch by ID" GraphQL lookup the way
  // products/customers/orders do. Left FAILED; Shopify's own webhook
  // redelivery (Settings > Notifications > Webhooks, in the Partner-
  // visible event log) is the fallback for this one topic.
  throw new Error(`Topic ${topic} is not automatically retryable.`);
}

export async function retryFailedSyncEvents() {
  const events = await prisma.syncEvent.findMany({
    where: { status: "FAILED", retryCount: { lt: MAX_RETRIES } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });
  if (events.length === 0) return { retried: 0, succeeded: 0 };

  // Group by shop so each shop's Odoo client/admin session is created
  // once, not once per event - same reasoning as pollAllShopsInventory.
  const eventsByShop = new Map<string, typeof events>();
  for (const event of events) {
    const list = eventsByShop.get(event.shop) ?? [];
    list.push(event);
    eventsByShop.set(event.shop, list);
  }

  let succeeded = 0;

  for (const [shop, shopEvents] of eventsByShop) {
    let odoo;
    let admin;
    try {
      odoo = await getOdooClient(shop);
      admin = (await unauthenticated.admin(shop)).admin;
    } catch (error) {
      // Odoo disconnected or the shop itself uninstalled - skip this
      // shop's whole batch this tick rather than failing each event
      // individually with the same root cause.
      console.error(`Retry skipped for ${shop} - no active connection:`, error);
      continue;
    }

    for (const event of shopEvents) {
      if (!event.resourceId) {
        // Nothing to refetch a resource by - can't ever succeed.
        await prisma.syncEvent.update({
          where: { id: event.id },
          data: { retryCount: { increment: 1 }, lastRetryAt: new Date() },
        });
        continue;
      }

      try {
        await retryEvent(admin, shop, odoo, event.topic, event.resourceId);
        await prisma.syncEvent.update({
          where: { id: event.id },
          data: {
            status: "COMPLETED",
            processedAt: new Date(),
            lastRetryAt: new Date(),
            retryCount: { increment: 1 },
            error: null,
          },
        });
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown retry error";
        await prisma.syncEvent.update({
          where: { id: event.id },
          data: {
            retryCount: { increment: 1 },
            lastRetryAt: new Date(),
            error: message.slice(0, 2000),
          },
        });
      }
    }
  }

  return { retried: events.length, succeeded };
}

declare global {
  // eslint-disable-next-line no-var
  var syncRetryPollerInterval: NodeJS.Timeout | undefined;
}

/*
 * Guarded the same way startInventoryPoller() guards its own interval -
 * see that function's comment for why the global survives Vite's
 * dev-mode HMR without stacking a second timer.
 */
export function startSyncRetryPoller() {
  if (global.syncRetryPollerInterval) return;

  const intervalMs = Number(process.env.SYNC_RETRY_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  global.syncRetryPollerInterval = setInterval(() => {
    retryFailedSyncEvents().catch((error) => {
      console.error("Sync retry poller tick failed:", error);
    });
  }, intervalMs);

  global.syncRetryPollerInterval.unref?.();
}
