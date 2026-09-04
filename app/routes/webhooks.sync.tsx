import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordAndProcessWebhook } from "../services/sync/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);

  try {
    await recordAndProcessWebhook({
      webhookId,
      shop,
      topic: String(topic),
      payload,
    });
  } catch (error) {
    console.error(`Failed to process ${String(topic)} webhook for ${shop}:`, error);
    return new Response("Webhook synchronization failed.", { status: 500 });
  }

  return new Response();
};
