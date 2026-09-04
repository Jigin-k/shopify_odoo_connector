import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import prisma from "../db.server";
import { OdooClient } from "../services/odoo/client.server";
import {
  fetchImageAsBase64,
  syncProductToOdoo,
  type ShopifyVariantForOdoo,
} from "../services/odoo/products.server";
import { authenticate } from "../shopify.server";

type ShopifyVariant = {
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
};

type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml: string;
  featuredMedia: { image: { url: string } } | null;
  variants: { nodes: ShopifyVariant[] };
};

// Odoo's `weight` field is in kilograms by default - Shopify's
// InventoryItem.measurement.weight can report in any of these units, so
// every value needs converting to the same base before Odoo sees it, or
// a product weighed in ounces would show as if it were kilograms.
const WEIGHT_TO_KG: Record<string, number> = {
  GRAMS: 0.001,
  KILOGRAMS: 1,
  OUNCES: 0.0283495,
  POUNDS: 0.453592,
};

function toOdooVariant(variant: ShopifyVariant): ShopifyVariantForOdoo {
  const weightInfo = variant.inventoryItem.measurement.weight;
  const weightKg = weightInfo
    ? weightInfo.value * (WEIGHT_TO_KG[weightInfo.unit] ?? 1)
    : null;
  return {
    shopifyVariantId: variant.id,
    sku: variant.sku,
    price: variant.price,
    title: variant.title,
    weight: weightKg,
    cost: variant.inventoryItem.unitCost
      ? Number(variant.inventoryItem.unitCost.amount)
      : null,
  };
}

type ProductsQueryResponse = {
  data?: {
    products: {
      nodes: ShopifyProduct[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
};

type ProductQueryResponse = {
  data?: { product: ShopifyProduct | null };
  errors?: Array<{ message: string }>;
};

const productDetailFields = `#graphql
  fragment OdooConnectorProductDetailFields on Product {
    id title handle status
    descriptionHtml
    featuredMedia {
      ... on MediaImage { image { url } }
    }
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
`;

async function loadAllProducts(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
) {
  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;

  do {
    const response = await admin.graphql(
      `#graphql
        ${productDetailFields}
        query OdooConnectorAllProducts($cursor: String) {
          products(first: 100, after: $cursor, sortKey: UPDATED_AT) {
            nodes { ...OdooConnectorProductDetailFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const data = (await response.json()) as ProductsQueryResponse;
    if (!data.data) {
      throw new Error(data.errors?.[0]?.message || "Unable to load Shopify products.");
    }

    products.push(...data.data.products.nodes);
    cursor = data.data.products.pageInfo.hasNextPage
      ? data.data.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return products;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
    query OdooConnectorProducts {
      products(first: 25, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          title
          handle
          status
          variants(first: 10) {
            nodes { id title sku price inventoryItem { tracked requiresShipping } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `);
  const data = (await response.json()) as ProductsQueryResponse;

  if (!data.data) {
    throw new Error(data.errors?.[0]?.message || "Unable to load Shopify products.");
  }

  const [connection, mappings] = await Promise.all([
    prisma.odooConnection.findUnique({ where: { shop: session.shop } }),
    prisma.syncMapping.findMany({
      where: {
        shop: session.shop,
        resourceType: "product",
        shopifyId: { in: data.data.products.nodes.map((product) => product.id) },
      },
    }),
  ]);
  const odooIds = new Map(
    mappings.map((mapping) => [mapping.shopifyId, mapping.odooId]),
  );
  const products = data.data.products.nodes.map((product) => ({
    ...product,
    odooId: odooIds.get(product.id) ?? null,
  }));

  return {
    products,
    connected: Boolean(connection?.active),
    syncedCount: products.filter((product) => product.odooId).length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "sync-one");
  const productId = String(formData.get("productId") || "");

  if (intent !== "sync-all" && !productId) {
    return { success: false, message: "Shopify product ID is missing." };
  }

  const connection = await prisma.odooConnection.findUnique({
    where: { shop: session.shop },
  });
  if (!connection?.active) {
    return {
      success: false,
      message: "Connect Odoo before synchronizing products.",
    };
  }

  try {
    const odoo = new OdooClient({
      url: connection.odooUrl,
      database: connection.database,
      apiKey: connection.apiKey,
    });

    if (intent === "sync-all") {
      const products = await loadAllProducts(admin);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const failures: string[] = [];

      for (const product of products) {
        const variant = product.variants.nodes[0];
        if (!variant) {
          skipped += 1;
          continue;
        }

        try {
          const imageBase64 = await fetchImageAsBase64(
            product.featuredMedia?.image.url,
          );
          const result = await syncProductToOdoo(
            odoo,
            {
              title: product.title,
              sku: variant.sku,
              price: variant.price,
              shopifyVariantId: variant.id,
              description: product.descriptionHtml,
              imageBase64,
              requiresShipping: variant.inventoryItem.requiresShipping,
              tracked: variant.inventoryItem.tracked,
              variants: product.variants.nodes.map(toOdooVariant),
            },
            { shop: session.shop, shopifyId: product.id },
          );
          if (result.action === "created") created += 1;
          else updated += 1;
        } catch (error) {
          failures.push(
            `${product.title}: ${error instanceof Error ? error.message : "sync failed"}`,
          );
        }
      }

      const summary = `${created} created, ${updated} updated, ${skipped} skipped`;
      if (failures.length) {
        return {
          success: false,
          message: `Bulk sync partially completed (${summary}, ${failures.length} failed). First error: ${failures[0]}`,
        };
      }
      return { success: true, message: `All products synchronized (${summary}).` };
    }

    const response = await admin.graphql(
      `#graphql
        ${productDetailFields}
        query OdooConnectorProduct($id: ID!) {
          product(id: $id) {
            ...OdooConnectorProductDetailFields
          }
        }
      `,
      { variables: { id: productId } },
    );
    const data = (await response.json()) as ProductQueryResponse;
    const product = data.data?.product;

    if (!product) {
      return {
        success: false,
        message: data.errors?.[0]?.message || "Shopify product was not found.",
      };
    }

    const variant = product.variants.nodes[0];
    if (!variant) {
      return { success: false, message: "This product has no variant." };
    }

    const imageBase64 = await fetchImageAsBase64(product.featuredMedia?.image.url);
    const result = await syncProductToOdoo(
      odoo,
      {
        title: product.title,
        sku: variant.sku,
        price: variant.price,
        shopifyVariantId: variant.id,
        description: product.descriptionHtml,
        imageBase64,
        requiresShipping: variant.inventoryItem.requiresShipping,
        tracked: variant.inventoryItem.tracked,
        variants: product.variants.nodes.map(toOdooVariant),
      },
      { shop: session.shop, shopifyId: product.id },
    );

    return {
      success: true,
      message:
        result.action === "created"
          ? `${product.title} was created in Odoo as product #${result.odooProductId}.`
          : `${product.title} was updated in Odoo as product #${result.odooProductId}.`,
    };
  } catch (error) {
    console.error("Product synchronization error:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Product sync failed.",
    };
  }
};

function productTone(status: string): "success" | "info" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "info";
  return "neutral";
}

export default function ProductsPage() {
  const { products, connected, syncedCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const syncingProductId =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("productId") || "")
      : null;
  const syncingAll =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync-all";

  return (
    <s-page heading="Products">
      {!connected && (
        <s-banner heading="Odoo connection required" tone="warning">
          Connect and test your Odoo instance before synchronizing products. {" "}
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
          <s-text color="subdued">Products loaded</s-text>
          <s-heading>{products.length}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Synced with Odoo</s-text>
          <s-heading>{syncedCount}</s-heading>
        </s-box>
        <s-box padding="base" border="base" borderRadius="base">
          <s-text color="subdued">Awaiting sync</s-text>
          <s-heading>{products.length - syncedCount}</s-heading>
        </s-box>
      </s-grid>

      <s-section heading="Shopify catalog">
        <Form method="post">
          <input type="hidden" name="intent" value="sync-all" />
          <s-button
            type="submit"
            variant="primary"
            disabled={!connected || syncingAll || products.length === 0}
            {...(syncingAll ? { loading: true } : {})}
          >
            Sync all products
          </s-button>
        </Form>
        <s-paragraph color="subdued">
          The 25 most recently updated products are shown. Real-time webhooks
          keep mapped products synchronized after the initial sync.
        </s-paragraph>

        {products.length === 0 ? (
          <s-box padding="large" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>No products found</s-heading>
              <s-paragraph>Create a product in Shopify, then return here to synchronize it.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>First variant</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
              <s-table-header>Odoo</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((product) => {
                const variant = product.variants.nodes[0];
                const syncing = syncingProductId === product.id;
                return (
                  <s-table-row key={product.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-200">
                        <s-text type="strong">{product.title}</s-text>
                        <s-text color="subdued">/{product.handle}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={productTone(product.status)}>
                        {product.status.toLowerCase()}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{variant?.title || "No variant"}</s-table-cell>
                    <s-table-cell>{variant?.sku || "—"}</s-table-cell>
                    <s-table-cell>{variant?.price || "—"}</s-table-cell>
                    <s-table-cell>
                      {product.odooId ? (
                        <s-badge tone="success">Synced #{product.odooId}</s-badge>
                      ) : (
                        <s-badge tone="caution">Not synced</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <Form method="post">
                        <input type="hidden" name="productId" value={product.id} />
                        <input type="hidden" name="intent" value="sync-one" />
                        <s-button
                          type="submit"
                          disabled={!connected || syncing}
                          {...(syncing ? { loading: true } : {})}
                        >
                          {product.odooId ? "Resync" : "Sync"}
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
