import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type ResourceCounts = { product: number; customer: number; order: number };

const RESOURCE_LABELS: Record<keyof ResourceCounts, string> = {
  product: "Products",
  customer: "Customers",
  order: "Orders",
};

function eventTone(status: string): "success" | "warning" | "critical" {
  if (status === "COMPLETED") return "success";
  if (status === "PROCESSING") return "warning";
  return "critical";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [connection, mappingCounts, recentEvents, failedCount] = await Promise.all([
    prisma.odooConnection.findUnique({ where: { shop } }),
    prisma.syncMapping.groupBy({
      by: ["resourceType"],
      where: { shop },
      _count: { _all: true },
    }),
    prisma.syncEvent.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.syncEvent.count({
      where: {
        shop,
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const counts: ResourceCounts = { product: 0, customer: 0, order: 0 };
  for (const row of mappingCounts) {
    if (row.resourceType === "product" || row.resourceType === "customer" || row.resourceType === "order") {
      counts[row.resourceType] = row._count._all;
    }
  }

  return {
    connected: Boolean(connection?.active),
    odooUrl: connection?.odooUrl ?? null,
    lastTestedAt: connection?.lastTestedAt ?? null,
    counts,
    recentEvents,
    failedCount,
  };
};

export default function Dashboard() {
  const { connected, odooUrl, lastTestedAt, counts, recentEvents, failedCount } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Odoo Connector">
      {!connected && (
        <s-banner heading="Connect Odoo to start syncing" tone="warning">
          No active Odoo connection is configured for this store. This
          requires the Shopify Connector module installed on your Odoo
          server first.{" "}
          <s-link href="/app/odoo">Open Odoo connection</s-link>
        </s-banner>
      )}

      {failedCount > 0 && (
        <s-banner heading="Recent sync failures" tone="critical">
          {failedCount} sync{failedCount === 1 ? "" : "s"} failed in the last
          24 hours. Check the activity log below for details.
        </s-banner>
      )}

      <s-section heading="Connection status">
        {connected ? (
          <s-stack direction="block" gap="small-200">
            <s-badge tone="success">Connected</s-badge>
            <s-paragraph color="subdued">
              {odooUrl}
              {lastTestedAt
                ? ` — last tested ${new Date(lastTestedAt).toLocaleString()}`
                : ""}
            </s-paragraph>
          </s-stack>
        ) : (
          <s-badge tone="caution">Not connected</s-badge>
        )}
      </s-section>

      <s-section heading="Sync overview">
        <s-grid gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="base">
          {(Object.keys(RESOURCE_LABELS) as Array<keyof ResourceCounts>).map((resource) => (
            <s-box key={resource} padding="base" border="base" borderRadius="base">
              <s-text color="subdued">{RESOURCE_LABELS[resource]} synced</s-text>
              <s-heading>{counts[resource]}</s-heading>
            </s-box>
          ))}
        </s-grid>

        <s-stack direction="inline" gap="base">
          <s-link href="/app/products">View products</s-link>
          <s-link href="/app/customers">View customers</s-link>
          <s-link href="/app/orders">View orders</s-link>
          <s-link href="/app/inventory">View inventory</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Recent sync activity">
        {recentEvents.length === 0 ? (
          <s-paragraph color="subdued">
            No sync activity yet. Activity will appear here once Shopify
            sends the first webhook or you run a manual sync.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Topic</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Resource</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentEvents.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{event.topic}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={eventTone(event.status)}>{event.status.toLowerCase()}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{event.resourceId || "—"}</s-table-cell>
                  <s-table-cell>{new Date(event.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-paragraph color="subdued">
        Developed by{" "}
        <s-link href="https://www.cybrosys.com" target="_blank">
          Cybrosys Technologies
        </s-link>
      </s-paragraph>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
