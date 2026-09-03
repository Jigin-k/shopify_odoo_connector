import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";

import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";
import { OdooClient } from "../services/odoo/client.server";
import prisma from "../db.server";


export const loader = async ({
  request,
}: LoaderFunctionArgs) => {

  const { session } = await authenticate.admin(request);

  const connection = await prisma.odooConnection.findUnique({
    where: { shop: session.shop },
  });

  return {
    connected: Boolean(connection?.active),
    odooUrl: connection?.odooUrl ?? "",
    database: connection?.database ?? "",
    lastTestedAt: connection?.lastTestedAt ?? null,
  };
};


export const action = async ({
  request,
}: ActionFunctionArgs) => {

  // Authenticate the Shopify request
  // and get the current Shopify session.
  const { session } = await authenticate.admin(request);

  const shop = session.shop;

  const formData = await request.formData();

  const url = String(
    formData.get("url") || "",
  ).trim();

  const database = String(
    formData.get("database") || "",
  ).trim();

  const apiKey = String(
    formData.get("apiKey") || "",
  ).trim();


  // Validate required fields
  if (!url || !database || !apiKey) {
    return {
      success: false,
      message: "All fields are required.",
    };
  }


  try {

    /*
     * Create temporary Odoo client.
     *
     * The credentials are NOT saved until
     * the connection test succeeds.
     */
    const odoo = new OdooClient({
      url,
      database,
      apiKey,
    });


    /*
     * Test the Odoo connection.
     *
     * For now we simply try reading one user.
     * Later we can improve this to retrieve
     * current user/company/version information.
     */
    await odoo.call(
      "res.users",
      "search_read",
      {
        domain: [],
        fields: ["id", "name"],
        limit: 1,
      },
    );


    /*
     * Connection succeeded.
     *
     * Save/update the Odoo connection belonging
     * to the currently installed Shopify store.
     */
    await prisma.odooConnection.upsert({

      where: {
        shop,
      },

      update: {
        odooUrl: url,
        database,
        apiKey,
        active: true,
        lastTestedAt: new Date(),
      },

      create: {
        shop,
        odooUrl: url,
        database,
        apiKey,
        active: true,
        lastTestedAt: new Date(),
      },

    });


    return {
      success: true,
      message: "Odoo connection successful and saved.",
    };


  } catch (error) {

    console.error(
      "Odoo connection error:",
      error,
    );

    return {
      success: false,

      message:
        error instanceof Error
          ? error.message
          : "Unable to connect to Odoo.",
    };
  }
};


export default function OdooConnectionPage() {

  const { connected, odooUrl, database, lastTestedAt } =
    useLoaderData<typeof loader>();

  const actionData =
    useActionData<typeof action>();

  const navigation =
    useNavigation();

  const isSubmitting =
    navigation.state === "submitting";


  return (

    <s-page heading="Odoo Connection">

      {!connected && (
        <s-banner heading="Requires the Shopify Connector Odoo module" tone="info">
          This app syncs data by calling a companion module installed on
          your own Odoo server — it can&apos;t connect to a plain,
          unmodified Odoo instance. Ask your Odoo administrator or partner to install
          the <s-text type="strong">Shopify Connector</s-text> module
          first, then fill in its connection details below.
        </s-banner>
      )}

      <s-section heading="Connection status">
        {connected ? (
          <s-stack direction="block" gap="small-200">
            <s-badge tone="success">Connected</s-badge>
            <s-paragraph color="subdued">
              {odooUrl} ({database})
              {lastTestedAt
                ? ` — last tested ${new Date(lastTestedAt).toLocaleString()}`
                : ""}
            </s-paragraph>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small-200">
            <s-badge tone="caution">Not connected</s-badge>
            <s-paragraph color="subdued">
              No Odoo instance is connected yet. Fill in the details below
              and test the connection to start syncing.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Connect your Odoo instance">

        <s-paragraph color="subdued">
          Credentials are only saved after the test succeeds, and are
          never exposed to the browser once saved.
        </s-paragraph>

        <Form method="post">
          <s-stack direction="block" gap="base">

            <s-text-field
              label="Odoo URL"
              name="url"
              placeholder="https://yourcompany.odoo.com"
              defaultValue={odooUrl}
            />

            <s-text-field
              label="Database"
              name="database"
              placeholder="mycompany"
              defaultValue={database}
            />

            <s-password-field
              label="API Key"
              name="apiKey"
              autocomplete="off"
              details="From the connecting user's Odoo profile: My Profile → Account Security → New API Key."
            />

            <s-button
              type="submit"
              variant="primary"
              disabled={isSubmitting}
              {...(isSubmitting ? { loading: true } : {})}
            >
              {isSubmitting
                ? "Testing..."
                : connected
                  ? "Retest & Save Connection"
                  : "Test & Save Connection"}
            </s-button>

          </s-stack>
        </Form>

        {actionData && (
          <s-banner tone={actionData.success ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        )}

      </s-section>

    </s-page>
  );
}
