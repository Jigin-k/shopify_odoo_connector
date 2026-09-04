import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import prisma from "../db.server";
import { syncCustomerToOdoo } from "../services/odoo/customers.server";
import { getOdooClient } from "../services/odoo/sync.server";
import { authenticate } from "../shopify.server";

type Address = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
};
type ShopifyCustomer = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  state: string;
  numberOfOrders: string;
  defaultEmailAddress: { emailAddress: string } | null;
  defaultPhoneNumber: { phoneNumber: string } | null;
  amountSpent: { amount: string; currencyCode: string };
  defaultAddress: Address | null;
};

const customerFields = `#graphql
  fragment OdooConnectorCustomerFields on Customer {
    id
    displayName
    firstName
    lastName
    state
    numberOfOrders
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
    amountSpent { amount currencyCode }
    defaultAddress { address1 address2 city province zip country }
  }
`;

async function loadAllCustomers(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
) {
  const customers: ShopifyCustomer[] = [];
  let cursor: string | null = null;

  do {
    const response = await admin.graphql(
      `#graphql
        ${customerFields}
        query OdooConnectorAllCustomers($cursor: String) {
          customers(first: 100, after: $cursor, sortKey: UPDATED_AT) {
            nodes { ...OdooConnectorCustomerFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = (await response.json()) as {
      data?: {
        customers: {
          nodes: ShopifyCustomer[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (!json.data) {
      throw new Error(json.errors?.[0]?.message || "Unable to load Shopify customers.");
    }

    customers.push(...json.data.customers.nodes);
    cursor = json.data.customers.pageInfo.hasNextPage
      ? json.data.customers.pageInfo.endCursor
      : null;
  } while (cursor);

  return customers;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
    ${customerFields}
    query OdooConnectorCustomers {
      customers(first: 25, sortKey: UPDATED_AT, reverse: true) {
        nodes { ...OdooConnectorCustomerFields }
      }
    }
  `);
  const json = (await response.json()) as {
    data?: { customers: { nodes: ShopifyCustomer[] } };
    errors?: Array<{ message: string }>;
  };
  if (!json.data) {
    throw new Error(json.errors?.[0]?.message || "Unable to load customers.");
  }

  const [connection, mappings] = await Promise.all([
    prisma.odooConnection.findUnique({ where: { shop: session.shop } }),
    prisma.syncMapping.findMany({
      where: {
        shop: session.shop,
        resourceType: "customer",
        shopifyId: { in: json.data.customers.nodes.map((customer) => customer.id) },
      },
    }),
  ]);
  const odooIds = new Map(
    mappings.map((mapping) => [mapping.shopifyId, mapping.odooId]),
  );
  const customers = json.data.customers.nodes.map((customer) => ({
    ...customer,
    odooId: odooIds.get(customer.id) ?? null,
  }));

  return {
    customers,
    connected: Boolean(connection?.active),
    syncedCount: customers.filter((customer) => customer.odooId).length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "sync-one");
  const customerId = String(formData.get("customerId") || "");

  if (intent !== "sync-all" && !customerId) {
    return { success: false, message: "Shopify customer ID is missing." };
  }

  try {
    if (intent === "sync-all") {
      const odoo = await getOdooClient(session.shop);
      const customers = await loadAllCustomers(admin);
      let synced = 0;
      const failures: string[] = [];

      for (const customer of customers) {
        try {
          await syncCustomerToOdoo(session.shop, odoo, {
            id: customer.id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.defaultEmailAddress?.emailAddress,
            phone: customer.defaultPhoneNumber?.phoneNumber,
            address: customer.defaultAddress,
          });
          synced += 1;
        } catch (error) {
          failures.push(
            `${customer.displayName}: ${error instanceof Error ? error.message : "sync failed"}`,
          );
        }
      }

      if (failures.length) {
        return {
          success: false,
          message: `Bulk sync partially completed (${synced} synced, ${failures.length} failed). First error: ${failures[0]}`,
        };
      }
      return { success: true, message: `All customers synchronized (${synced} synced).` };
    }

    const response = await admin.graphql(
      `#graphql
        ${customerFields}
        query OdooConnectorCustomer($id: ID!) {
          customer(id: $id) { ...OdooConnectorCustomerFields }
        }
      `,
      { variables: { id: customerId } },
    );
    const json = (await response.json()) as {
      data?: { customer: ShopifyCustomer | null };
      errors?: Array<{ message: string }>;
    };
    const customer = json.data?.customer;
    if (!customer) {
      return {
        success: false,
        message: json.errors?.[0]?.message || "Shopify customer was not found.",
      };
    }

    const odoo = await getOdooClient(session.shop);
    const odooId = await syncCustomerToOdoo(session.shop, odoo, {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.defaultEmailAddress?.emailAddress,
      phone: customer.defaultPhoneNumber?.phoneNumber,
      address: customer.defaultAddress,
    });
    return {
      success: true,
      message: `${customer.displayName} synchronized to Odoo contact #${odooId}.`,
    };
  } catch (error) {
    console.error("Customer synchronization error:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Customer sync failed.",
    };
  }
};

export default function CustomersPage() {
  const { customers, connected, syncedCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const syncingCustomerId =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("customerId") || "")
      : null;
  const syncingAll =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync-all";

  return (
    <s-page heading="Customers">
      {!connected && (
        <s-banner heading="Odoo connection required" tone="warning">
          Connect Odoo before synchronizing customers. {" "}
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
          <s-text color="subdued">Customers loaded</s-text><s-heading>{customers.length}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Synced with Odoo</s-text><s-heading>{syncedCount}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Awaiting sync</s-text><s-heading>{customers.length - syncedCount}</s-heading>
        </s-box>
      </s-grid>

      <s-section heading="Shopify customers">
        <Form method="post">
          <input type="hidden" name="intent" value="sync-all" />
          <s-button
            type="submit"
            variant="primary"
            disabled={!connected || syncingAll || customers.length === 0}
            {...(syncingAll ? { loading: true } : {})}
          >
            Sync all customers
          </s-button>
        </Form>
        <s-paragraph color="subdued">
          The 25 most recently updated customers are shown. Customer webhooks
          keep mapped Odoo contacts updated after the initial sync.
        </s-paragraph>
        {customers.length === 0 ? (
          <s-box padding="large" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>No customers found</s-heading>
              <s-paragraph>Customers will appear here after they register or place an order.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Orders</s-table-header>
              <s-table-header format="currency">Spent</s-table-header>
              <s-table-header>Odoo</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {customers.map((customer) => {
                const syncing = syncingCustomerId === customer.id;
                return (
                  <s-table-row key={customer.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        <s-text type="strong">{customer.displayName}</s-text>
                        <s-badge tone={customer.state === "ENABLED" ? "success" : "neutral"}>
                          {customer.state.toLowerCase()}
                        </s-badge>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{customer.defaultEmailAddress?.emailAddress || "—"}</s-table-cell>
                    <s-table-cell>{customer.defaultPhoneNumber?.phoneNumber || "—"}</s-table-cell>
                    <s-table-cell>{customer.numberOfOrders}</s-table-cell>
                    <s-table-cell>{customer.amountSpent.amount} {customer.amountSpent.currencyCode}</s-table-cell>
                    <s-table-cell>
                      {customer.odooId ? <s-badge tone="success">Synced #{customer.odooId}</s-badge> : <s-badge tone="caution">Not synced</s-badge>}
                    </s-table-cell>
                    <s-table-cell>
                      <Form method="post">
                        <input type="hidden" name="customerId" value={customer.id} />
                        <input type="hidden" name="intent" value="sync-one" />
                        <s-button type="submit" disabled={!connected || syncing} {...(syncing ? { loading: true } : {})}>
                          {customer.odooId ? "Resync" : "Sync"}
                        </s-button>
                      </Form>
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
