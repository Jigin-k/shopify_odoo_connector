import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import prisma from "../db.server";
import { getOdooClient } from "../services/odoo/sync.server";
import { syncOrderToOdoo } from "../services/odoo/orders.server";
import { authenticate } from "../shopify.server";

type Money = { amount: string; currencyCode: string };
type Address = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
};
type OrderSummary = {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { displayName: string } | null;
  totalPriceSet: { shopMoney: Money };
};
type OrderDetail = OrderSummary & {
  email: string | null;
  currencyCode: string;
  cancelledAt: string | null;
  taxesIncluded: boolean;
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
      originalUnitPriceSet: { shopMoney: Money };
    }>;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
    query OdooConnectorOrders {
      orders(first: 20, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          customer { displayName }
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  `);
  const json = (await response.json()) as {
    data?: { orders: { nodes: OrderSummary[] } };
    errors?: Array<{ message: string }>;
  };

  if (!json.data) {
    throw new Error(json.errors?.[0]?.message || "Unable to load Shopify orders.");
  }

  const [connection, mappings] = await Promise.all([
    prisma.odooConnection.findUnique({ where: { shop: session.shop } }),
    prisma.syncMapping.findMany({
      where: {
        shop: session.shop,
        resourceType: "order",
        shopifyId: { in: json.data.orders.nodes.map((order) => order.id) },
      },
    }),
  ]);
  const odooIds = new Map(
    mappings.map((mapping) => [mapping.shopifyId, mapping.odooId]),
  );
  const orders = json.data.orders.nodes.map((order) => ({
    ...order,
    odooId: odooIds.get(order.id) ?? null,
  }));

  return {
    orders,
    connected: Boolean(connection?.active),
    syncedCount: orders.filter((order) => order.odooId).length,
  };
};

const orderDetailFields = `#graphql
  fragment OdooConnectorOrderDetailFields on Order {
    id name email currencyCode createdAt cancelledAt
    displayFinancialStatus displayFulfillmentStatus
    taxesIncluded
    totalPriceSet { shopMoney { amount currencyCode } }
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
        originalUnitPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

function orderDetailToOdooInput(order: OrderDetail) {
  return {
    id: order.id,
    name: order.name,
    email: order.email,
    currency: order.currencyCode,
    financialStatus: order.displayFinancialStatus,
    cancelledAt: order.cancelledAt,
    taxesIncluded: order.taxesIncluded,
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
  };
}

async function loadAllOrderDetails(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
) {
  const orders: OrderDetail[] = [];
  let cursor: string | null = null;

  do {
    const response = await admin.graphql(
      `#graphql
        ${orderDetailFields}
        query OdooConnectorAllOrders($cursor: String) {
          orders(first: 50, after: $cursor, sortKey: CREATED_AT) {
            nodes { ...OdooConnectorOrderDetailFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        orders: {
          nodes: OrderDetail[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (!json.data) {
      throw new Error(json.errors?.[0]?.message || "Unable to load Shopify orders.");
    }

    orders.push(...json.data.orders.nodes);
    cursor = json.data.orders.pageInfo.hasNextPage ? json.data.orders.pageInfo.endCursor : null;
  } while (cursor);

  return orders;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "sync-one");
  const orderId = String(formData.get("orderId") || "");

  if (intent !== "sync-all" && !orderId) {
    return { success: false, message: "Shopify order ID is missing." };
  }

  try {
    if (intent === "sync-all") {
      const odoo = await getOdooClient(session.shop);
      const orders = await loadAllOrderDetails(admin);
      let synced = 0;
      const failures: string[] = [];

      for (const order of orders) {
        try {
          await syncOrderToOdoo(session.shop, odoo, orderDetailToOdooInput(order));
          synced += 1;
        } catch (error) {
          failures.push(
            `${order.name}: ${error instanceof Error ? error.message : "sync failed"}`,
          );
        }
      }

      if (failures.length) {
        return {
          success: false,
          message: `Bulk sync partially completed (${synced} synced, ${failures.length} failed). First error: ${failures[0]}`,
        };
      }
      return { success: true, message: `All orders synchronized (${synced} synced).` };
    }

    const response = await admin.graphql(
      `#graphql
        ${orderDetailFields}
        query OdooConnectorOrder($id: ID!) {
          order(id: $id) { ...OdooConnectorOrderDetailFields }
        }
      `,
      { variables: { id: orderId } },
    );
    const json = (await response.json()) as {
      data?: { order: OrderDetail | null };
      errors?: Array<{ message: string }>;
    };
    const order = json.data?.order;

    if (!order) {
      return {
        success: false,
        message: json.errors?.[0]?.message || "Shopify order was not found.",
      };
    }

    const odoo = await getOdooClient(session.shop);
    const odooId = await syncOrderToOdoo(session.shop, odoo, orderDetailToOdooInput(order));

    return {
      success: true,
      message: `${order.name} synchronized to Odoo sales order ${odooId}.`,
    };
  } catch (error) {
    console.error("Order synchronization error:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Order sync failed.",
    };
  }
};

export default function OrdersPage() {
  const { orders, connected, syncedCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const syncingOrderId =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("orderId") || "")
      : null;
  const syncingAll =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync-all";

  return (
    <s-page heading="Orders">
      {!connected && (
        <s-banner heading="Odoo connection required" tone="warning">
          Connect and test your Odoo instance before synchronizing orders. {" "}
          <s-link href="/app/odoo">Open Odoo connection</s-link>
        </s-banner>
      )}
      {actionData && (
        <s-banner tone={actionData.success ? "success" : "critical"}>
          {actionData.message}
        </s-banner>
      )}

      <s-grid gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="base">
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Orders loaded</s-text>
          <s-heading>{orders.length}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Synced with Odoo</s-text>
          <s-heading>{syncedCount}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Awaiting sync</s-text>
          <s-heading>{orders.length - syncedCount}</s-heading>
        </s-box>
      </s-grid>

      <s-section heading="Shopify orders">
        <Form method="post">
          <input type="hidden" name="intent" value="sync-all" />
          <s-button
            type="submit"
            variant="primary"
            disabled={!connected || syncingAll || orders.length === 0}
            {...(syncingAll ? { loading: true } : {})}
          >
            Sync all orders
          </s-button>
        </Form>
        <s-paragraph color="subdued">
          The 20 most recently created orders are shown. Real-time webhooks
          keep mapped orders synchronized after the initial sync.
        </s-paragraph>

        {orders.length === 0 ? (
          <s-box padding="large" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>No orders found</s-heading>
              <s-paragraph>Orders will appear here once a customer checks out.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Fulfillment</s-table-header>
              <s-table-header format="currency">Total</s-table-header>
              <s-table-header>Odoo</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>{order.name}</s-table-cell>
                  <s-table-cell>{order.customer?.displayName || "Guest"}</s-table-cell>
                  <s-table-cell><s-badge>{order.displayFinancialStatus || "Unknown"}</s-badge></s-table-cell>
                  <s-table-cell><s-badge>{order.displayFulfillmentStatus || "Unfulfilled"}</s-badge></s-table-cell>
                  <s-table-cell>{order.totalPriceSet.shopMoney.amount} {order.totalPriceSet.shopMoney.currencyCode}</s-table-cell>
                  <s-table-cell>{order.odooId ? `#${order.odooId}` : "Not synced"}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="intent" value="sync-one" />
                      <s-button type="submit" disabled={!connected || syncingOrderId === order.id}>
                        {syncingOrderId === order.id ? "Syncing..." : order.odooId ? "Resync" : "Sync"}
                      </s-button>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
