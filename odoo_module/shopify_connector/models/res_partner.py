from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ResPartner(models.Model):
    _name = "res.partner"
    _inherit = ["res.partner", "shopify.sync.mixin"]

    shopify_id = fields.Char(string="Shopify Customer ID", index=True, copy=False)
    shopify_shop = fields.Char(string="Shopify Shop", index=True, copy=False)
    shopify_synced_at = fields.Datetime(string="Last Shopify Sync", copy=False)

    _shopify_id_shop_uniq = models.Constraint(
        "unique(shopify_shop, shopify_id)",
        "A Shopify customer can only be mapped to one Odoo contact per shop.",
    )

    @api.model
    def shopify_sync_customer(self, vals):
        """Upsert a res.partner from a Shopify customer payload.

        Expected keys: ``shopify_shop``, ``shopify_id`` (required), plus
        ``name``, ``email``, ``phone``, ``street``, ``street2``, ``city``,
        ``zip``, ``comment``. Matches by shopify_shop+shopify_id first,
        then by email, before creating a new contact.
        """
        shopify_shop = vals.get("shopify_shop")
        shopify_id = vals.get("shopify_id")
        if not shopify_shop or not shopify_id:
            raise ValidationError("shopify_sync_customer requires shopify_shop and shopify_id.")

        def _do():
            partner = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_id)],
                limit=1,
            )
            write_vals = {
                key: value for key, value in vals.items() if key not in ("shopify_shop", "shopify_id")
            }
            write_vals["shopify_synced_at"] = fields.Datetime.now()
            write_vals.setdefault("customer_rank", 1)

            email = write_vals.get("email")
            if not partner and email:
                partner = self.sudo().search([("email", "=", email)], limit=1)

            if partner:
                partner.write(write_vals)
                action = "updated"
            else:
                write_vals.update(shopify_shop=shopify_shop, shopify_id=shopify_id)
                partner = self.sudo().create(write_vals)
                action = "created"

            return {"action": action, "id": partner.id, "model": "res.partner"}

        return self._shopify_sync_call(
            resource_type="customer",
            shopify_shop=shopify_shop,
            shopify_id=shopify_id,
            method="shopify_sync_customer",
            func=_do,
        )

    @api.model
    def shopify_archive_customer(self, shopify_shop, shopify_id):
        def _do():
            partner = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_id)],
                limit=1,
            )
            if partner:
                partner.write({"active": False})
            return {
                "action": "archived" if partner else "skipped",
                "id": partner.id if partner else False,
                "model": "res.partner",
            }

        return self._shopify_sync_call(
            resource_type="customer",
            shopify_shop=shopify_shop,
            shopify_id=shopify_id,
            method="shopify_archive_customer",
            func=_do,
        )
