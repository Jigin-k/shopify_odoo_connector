import time

from odoo import models


class ShopifySyncMixin(models.AbstractModel):
    """Shared helper for models exposing ``shopify_sync_*`` RPC methods.

    Every method the Shopify app calls over ``/json/2/<model>/<method>``
    wraps its work in ``_shopify_sync_call`` so success and failure are
    both timed and logged to ``shopify.sync.log`` the same way, and errors
    are still raised to the caller (so the app's own ``OdooClient.call``
    sees a proper HTTP error and can record it in its own ``SyncEvent``).
    """

    _name = "shopify.sync.mixin"
    _description = "Shopify Sync Mixin"

    def _shopify_sync_call(self, *, resource_type, shopify_shop, shopify_id, method, func):
        start = time.monotonic()
        try:
            result = func()
        except Exception as exc:
            self.env["shopify.sync.log"]._log(
                shopify_shop=shopify_shop,
                resource_type=resource_type,
                shopify_id=shopify_id,
                method=method,
                status="error",
                message=str(exc),
                duration_ms=int((time.monotonic() - start) * 1000),
            )
            raise
        self.env["shopify.sync.log"]._log(
            shopify_shop=shopify_shop,
            resource_type=resource_type,
            shopify_id=shopify_id,
            method=method,
            status="success",
            action=result.get("action"),
            odoo_model=result.get("model"),
            odoo_res_id=result.get("id"),
            duration_ms=int((time.monotonic() - start) * 1000),
        )
        return result
