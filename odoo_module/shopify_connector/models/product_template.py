from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ProductTemplate(models.Model):
    _name = "product.template"
    _inherit = ["product.template", "shopify.sync.mixin"]

    shopify_id = fields.Char(string="Shopify Product ID", index=True, copy=False)
    shopify_shop = fields.Char(string="Shopify Shop", index=True, copy=False)
    shopify_synced_at = fields.Datetime(string="Last Shopify Sync", copy=False)

    _shopify_id_shop_uniq = models.Constraint(
        "unique(shopify_shop, shopify_id)",
        "A Shopify product can only be mapped to one Odoo product template per shop.",
    )

    @api.model
    def shopify_sync_product(self, vals):
        """Upsert a product.template from a Shopify payload in one call.

        Expected ``vals`` keys: ``shopify_shop``, ``shopify_id`` (required),
        ``shopify_variant_id`` (optional, the primary/first variant's
        Shopify ID), plus any writable product.template field - typically
        ``name``, ``default_code``, ``list_price``, ``barcode``,
        ``description_sale``, ``active``.

        Matching order: existing shopify_shop+shopify_id mapping, then
        (for a never-before-seen Shopify ID) default_code/SKU, then - if a
        ``shopify_variant_id`` is given - a product.product already tagged
        with it. That last one matters: an order line for a variant with
        no SKU gets its product created by
        product.product._shopify_resolve_variant() the first time an order
        for it arrives, tagged only at the variant level. Without this
        check, catalog-syncing that same product afterwards would create a
        second, duplicate product.template instead of adopting the one
        that already exists.

        Whichever branch matches, the resulting template's primary variant
        is (re)tagged with ``shopify_variant_id`` so order-line resolution
        can find it by ID from then on, regardless of SKU.

        Returns ``{"action": "created"|"updated", "id": <template id>}``.
        """
        shopify_shop = vals.get("shopify_shop")
        shopify_id = vals.get("shopify_id")
        if not shopify_shop or not shopify_id:
            raise ValidationError("shopify_sync_product requires shopify_shop and shopify_id.")

        shopify_variant_id = vals.get("shopify_variant_id")

        def _do():
            product = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_id)],
                limit=1,
            )
            # shopify_shop/shopify_id stay in write_vals for every branch,
            # not just create: a product matched via the SKU or variant-id
            # fallback below still needs to be *tagged* with them, or it
            # keeps landing back on that same fallback (never the direct
            # shopify_id lookup) on every future sync - functionally fine,
            # but leaves the identity field this whole method exists to
            # populate permanently blank on that record.
            write_vals = {
                key: value for key, value in vals.items() if key != "shopify_variant_id"
            }
            write_vals["shopify_synced_at"] = fields.Datetime.now()

            if not product and write_vals.get("default_code"):
                product = self.sudo().search(
                    [("default_code", "=", write_vals["default_code"])], limit=1
                )

            if not product and shopify_variant_id:
                existing_variant = self.env["product.product"].sudo().search(
                    [
                        ("shopify_shop", "=", shopify_shop),
                        ("shopify_variant_id", "=", shopify_variant_id),
                    ],
                    limit=1,
                )
                product = existing_variant.product_tmpl_id

            if product:
                product.write(write_vals)
                action = "updated"
            else:
                product = self.sudo().create(write_vals)
                action = "created"

            if shopify_variant_id:
                variant = product.product_variant_ids[:1]
                if variant and variant.shopify_variant_id != shopify_variant_id:
                    # This module only tracks one variant per Shopify
                    # product (whichever one Shopify happens to report as
                    # "first"), while an order line can independently
                    # create a *separate* Odoo product for a sibling
                    # variant of the same Shopify product via
                    # _shopify_resolve_variant(). If Shopify's reported
                    # first variant changes between syncs (variants
                    # reordered, one deleted) it can land on an ID another
                    # product.product already owns - stamping it here
                    # anyway would violate the per-shop unique constraint
                    # and crash the whole product sync. Leave that other
                    # mapping alone instead; this template's own
                    # name/price/etc. above still synced correctly either
                    # way, it just won't carry this particular variant tag.
                    claimed_elsewhere = self.env["product.product"].sudo().search(
                        [
                            ("shopify_shop", "=", shopify_shop),
                            ("shopify_variant_id", "=", shopify_variant_id),
                            ("id", "!=", variant.id),
                        ],
                        limit=1,
                    )
                    if not claimed_elsewhere:
                        variant.write(
                            {"shopify_variant_id": shopify_variant_id, "shopify_shop": shopify_shop}
                        )

            return {"action": action, "id": product.id, "model": "product.template"}

        return self._shopify_sync_call(
            resource_type="product",
            shopify_shop=shopify_shop,
            shopify_id=shopify_id,
            method="shopify_sync_product",
            func=_do,
        )

    @api.model
    def shopify_archive_product(self, shopify_shop, shopify_id):
        """Archive the product mapped to a deleted Shopify product.

        Mirrors the app's own PRODUCTS_DELETE handling: Odoo records are
        archived, never hard-deleted, so history and existing sales/stock
        moves referencing them stay intact.
        """

        def _do():
            product = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_id)],
                limit=1,
            )
            if product:
                product.write({"active": False})
            return {
                "action": "archived" if product else "skipped",
                "id": product.id if product else False,
                "model": "product.template",
            }

        return self._shopify_sync_call(
            resource_type="product",
            shopify_shop=shopify_shop,
            shopify_id=shopify_id,
            method="shopify_archive_product",
            func=_do,
        )
