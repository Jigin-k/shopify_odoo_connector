import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type InventoryVariant = {
  id: string;
  title: string;
  sku: string | null;
  product: { id: string; title: string };
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: {
      nodes: Array<{
        location: { id: string; name: string };
        quantities: Array<{ name: string; quantity: number }>;
      }>;
    };
  };
};
type InventoryRow = InventoryVariant & {
  locationId: string | null;
  locationName: string;
  available: number;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
    query OdooConnectorInventory {
      productVariants(first: 50, sortKey: ID, reverse: true) {
        nodes {
          id
          title
          sku
          product { id title }
          inventoryItem {
            id
            tracked
            inventoryLevels(first: 10) {
              nodes {
                location { id name }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  `);
  const json = (await response.json()) as {
    data?: { productVariants: { nodes: InventoryVariant[] } };
    errors?: Array<{ message: string }>;
  };
  if (!json.data) {
    throw new Error(json.errors?.[0]?.message || "Unable to load inventory.");
  }

  const connection = await prisma.odooConnection.findUnique({
    where: { shop: session.shop },
  });
  const rows = json.data.productVariants.nodes.flatMap<InventoryRow>((variant) => {
    const levels = variant.inventoryItem.inventoryLevels.nodes;
    if (levels.length === 0) {
      return [{
        ...variant,
        locationId: null,
        locationName: "No location",
        available: 0,
      }];
    }
    return levels.map((level) => ({
      ...variant,
      locationId: level.location.id,
      locationName: level.location.name,
      available:
        level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0,
    }));
  });

  return {
    rows,
    connected: Boolean(connection?.active),
    trackedCount: json.data.productVariants.nodes.filter(
      (variant) => variant.inventoryItem.tracked,
    ).length,
    lowStockCount: rows.filter((row) => row.available > 0 && row.available <= 5).length,
    outOfStockCount: rows.filter((row) => row.available <= 0).length,
  };
};

function inventoryStatus(quantity: number) {
  if (quantity <= 0) return { label: "Out of stock", tone: "critical" as const };
  if (quantity <= 5) return { label: "Low stock", tone: "warning" as const };
  return { label: "In stock", tone: "success" as const };
}

export default function InventoryPage() {
  const { rows, connected, trackedCount, lowStockCount, outOfStockCount } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Inventory">
      {!connected && (
        <s-banner heading="Odoo connection required" tone="warning">
          Connect Odoo before configuring warehouse inventory synchronization. {" "}
          <s-link href="/app/odoo">Open Odoo connection</s-link>
        </s-banner>
      )}
      <s-banner heading="Inventory mapping is the next step" tone="info">
        This page currently monitors Shopify stock. Odoo quantities will only
        update Shopify after warehouses and locations are explicitly mapped:
        in Odoo, open each warehouse (Inventory → Configuration →
        Warehouses) and set its <s-text type="strong">Shopify Location ID
        </s-text> field to the matching location ID shown below.
      </s-banner>

      <s-grid gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="base">
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Tracked variants</s-text><s-heading>{trackedCount}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Low stock levels</s-text><s-heading>{lowStockCount}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Out of stock levels</s-text><s-heading>{outOfStockCount}</s-heading>
        </s-box>
      </s-grid>

      <s-section heading="Shopify inventory">
        <s-paragraph color="subdued">
          The latest 50 variants are shown across their Shopify locations.
        </s-paragraph>
        {rows.length === 0 ? (
          <s-box padding="large" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>No inventory found</s-heading>
              <s-paragraph>Add tracked product variants and location stock in Shopify.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Location</s-table-header>
              <s-table-header format="numeric">Available</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Tracking</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => {
                const status = inventoryStatus(row.available);
                return (
                  <s-table-row key={`${row.id}:${row.locationId || "none"}`}>
                    <s-table-cell><s-text type="strong">{row.product.title}</s-text></s-table-cell>
                    <s-table-cell>{row.title}</s-table-cell>
                    <s-table-cell>{row.sku || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        <s-text>{row.locationName}</s-text>
                        {row.locationId && (
                          <s-text color="subdued" fontVariantNumeric="tabular-nums">
                            {row.locationId}
                          </s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{row.available}</s-table-cell>
                    <s-table-cell><s-badge tone={status.tone}>{status.label}</s-badge></s-table-cell>
                    <s-table-cell>
                      <s-badge tone={row.inventoryItem.tracked ? "success" : "neutral"}>
                        {row.inventoryItem.tracked ? "Tracked" : "Not tracked"}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
