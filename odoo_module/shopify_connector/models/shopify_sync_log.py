from odoo import api, fields, models


class ShopifySyncLog(models.Model):
    """Record of every Shopify RPC call handled by this module.

    Mirrors the ``SyncEvent`` table on the Shopify app side, but from the
    Odoo point of view - it exists so an Odoo admin can see what the
    connector did (and why something failed) without needing access to
    the Shopify admin or the app's own database.
    """

    _name = "shopify.sync.log"
    _description = "Shopify Sync Log"
    _order = "create_date desc"
    _rec_name = "shopify_id"

    shopify_shop = fields.Char(required=True, index=True)
    resource_type = fields.Selection(
        [
            ("product", "Product"),
            ("customer", "Customer"),
            ("order", "Order"),
            ("inventory", "Inventory"),
        ],
        required=True,
        index=True,
    )
    shopify_id = fields.Char(index=True)
    method = fields.Char(required=True)
    status = fields.Selection(
        [("success", "Success"), ("error", "Error")],
        required=True,
        index=True,
    )
    action = fields.Char(help="created / updated / archived / skipped, as reported by the sync method.")
    odoo_model = fields.Char()
    odoo_res_id = fields.Integer()
    message = fields.Text(help="Error detail, truncated. Empty on success.")
    duration_ms = fields.Integer(string="Duration (ms)")

    @api.model
    def _log(
        self,
        *,
        shopify_shop,
        resource_type,
        shopify_id,
        method,
        status,
        action=None,
        odoo_model=None,
        odoo_res_id=None,
        message=None,
        duration_ms=None,
    ):
        # sudo(): the RPC user only needs read access to this model (see
        # ir.model.access.csv) so it can view its own history; writing the
        # log entry itself must always succeed regardless of that grant.
        return self.sudo().create(
            {
                "shopify_shop": shopify_shop,
                "resource_type": resource_type,
                "shopify_id": shopify_id,
                "method": method,
                "status": status,
                "action": action,
                "odoo_model": odoo_model,
                "odoo_res_id": odoo_res_id,
                "message": str(message)[:4000] if message else False,
                "duration_ms": duration_ms,
            }
        )
