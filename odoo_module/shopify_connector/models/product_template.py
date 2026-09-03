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

    def _shopify_tag_variant(self, variant, shopify_shop, shopify_variant_id, variant_write=None):
        """Write ``shopify_variant_id``/``shopify_shop`` onto ``variant``
        along with any other per-variant values (sku, price, weight,
        cost), unless that Shopify variant ID already belongs to a
        *different* product.product.

        Shared by both the single-variant tagging path and
        ``_shopify_sync_variants`` below - see the long-standing comment
        this replaces for why the "claimed elsewhere" check exists: an
        order line can independently create a separate product.product
        for a sibling variant via ``_shopify_resolve_variant()`` before
        catalog sync ever reaches it, and stamping the same Shopify
        variant ID onto two records would violate the per-shop unique
        constraint and crash the whole product sync.
        """
        variant_write = dict(variant_write or {})
        if shopify_variant_id and variant.shopify_variant_id != shopify_variant_id:
            claimed_elsewhere = self.env["product.product"].sudo().search(
                [
                    ("shopify_shop", "=", shopify_shop),
                    ("shopify_variant_id", "=", shopify_variant_id),
                    ("id", "!=", variant.id),
                ],
                limit=1,
            )
            if not claimed_elsewhere:
                variant_write["shopify_variant_id"] = shopify_variant_id
                variant_write["shopify_shop"] = shopify_shop
        if variant_write:
            variant.write(variant_write)

    def _shopify_variant_write_vals(self, variant_vals):
        # Deliberately excludes price - see the price_extra handling in
        # _shopify_sync_variants for why that one can't go through a
        # plain product.product.write() the way sku/cost/weight can.
        write_vals = {}
        if variant_vals.get("sku") and variant_vals["sku"] != False:
            write_vals["default_code"] = variant_vals["sku"]
        if variant_vals.get("cost") is not None:
            write_vals["standard_price"] = float(variant_vals["cost"])
        if variant_vals.get("weight") is not None:
            write_vals["weight"] = float(variant_vals["weight"])
        return write_vals

    def _shopify_sync_variants(self, template, shopify_shop, variants):
        """Ensure ``template`` has exactly one Odoo variant per entry in
        ``variants`` - a Shopify product's *full* variant list - each
        tagged with its own shopify_variant_id/sku/price/weight/cost.

        Odoo's usual variant modeling is per-option (a "Size" attribute,
        a "Color" attribute, one line each, Odoo generates every
        combination). Mirroring that faithfully would mean parsing each
        variant's option values back out, and Odoo generating the full
        cartesian product of every combination - including ones Shopify
        never actually sold (e.g. no Small/Blue, only Small/Red and
        Medium/Blue). Instead, this uses a single generic "Shopify
        Variant" attribute whose values are exactly the Shopify variant
        titles: N Shopify variants always produce exactly N Odoo
        variants, no more, no less, regardless of how many real options
        the product has. The trade-off is Odoo's native per-option
        variant matrix UI doesn't reflect Size/Color separately - a fair
        v2 if that UI matters more than sync correctness, but this way
        the catalog can never silently drop or invent a variant.

        Only adds attribute values (new Shopify variants); never removes
        one for a variant Shopify stopped sending, since that would
        archive/delete an Odoo variant that may already have stock moves
        or order lines against it - safer to leave a stale variant in
        place than risk destroying sales history over a catalog sync.
        """
        attribute = self.env["product.attribute"].sudo().search(
            [("name", "=", "Shopify Variant")], limit=1
        )
        if not attribute:
            attribute = self.env["product.attribute"].sudo().create(
                {"name": "Shopify Variant", "create_variant": "always"}
            )

        value_model = self.env["product.attribute.value"].sudo()
        value_by_title = {}
        for variant_vals in variants:
            title = (
                variant_vals.get("title")
                or variant_vals.get("sku")
                or variant_vals.get("shopify_variant_id")
                or "Default"
            )
            value = value_model.search(
                [("attribute_id", "=", attribute.id), ("name", "=", title)], limit=1
            )
            if not value:
                value = value_model.create({"attribute_id": attribute.id, "name": title})
            value_by_title[title] = value

        all_values = value_model.browse([v.id for v in value_by_title.values()])
        line = template.attribute_line_ids.filtered(lambda l: l.attribute_id == attribute)
        if not line:
            self.env["product.template.attribute.line"].sudo().create(
                {
                    "product_tmpl_id": template.id,
                    "attribute_id": attribute.id,
                    "value_ids": [(6, 0, all_values.ids)],
                }
            )
        else:
            missing = all_values - line.value_ids
            if missing:
                line.write({"value_ids": [(4, value.id) for value in missing]})

        template.invalidate_recordset(["product_variant_ids"])

        for variant_vals in variants:
            title = (
                variant_vals.get("title")
                or variant_vals.get("sku")
                or variant_vals.get("shopify_variant_id")
                or "Default"
            )
            value = value_by_title[title]
            variant = template.product_variant_ids.filtered(
                lambda p, v=value: v.id
                in p.product_template_attribute_value_ids.product_attribute_value_id.ids
            )[:1]
            if not variant:
                # Shouldn't happen once Odoo regenerates variants for the
                # attribute line above, but one missing row is never
                # worth failing the whole product sync over.
                continue

            # Per-variant price is NOT set via product.product.lst_price:
            # its inverse writes straight through to the *template's*
            # shared list_price in this Odoo version rather than deriving
            # a price_extra, so every variant's write would clobber the
            # same template field and all variants would converge on
            # whichever price was written last (confirmed against a real
            # Odoo instance while building this). The actual mechanism
            # for a per-variant price difference is price_extra on this
            # variant's own product.template.attribute.value record.
            price = variant_vals.get("price")
            if price is not None:
                ptav = variant.product_template_attribute_value_ids.filtered(
                    lambda x, v=value: x.product_attribute_value_id == v
                )
                if ptav:
                    ptav.write({"price_extra": float(price) - template.list_price})

            self._shopify_tag_variant(
                variant,
                shopify_shop,
                variant_vals.get("shopify_variant_id"),
                self._shopify_variant_write_vals(variant_vals),
            )

    @api.model
    def shopify_sync_product(self, vals):
        """Upsert a product.template from a Shopify payload in one call.

        Expected ``vals`` keys: ``shopify_shop``, ``shopify_id`` (required),
        plus any writable product.template field - typically ``name``,
        ``default_code``, ``list_price``, ``barcode``, ``description_sale``,
        ``image_1920``, ``weight``, ``active``.

        Variant handling: pass a ``variants`` list - one dict per Shopify
        variant, each with ``shopify_variant_id``, ``sku``, ``price``,
        ``title``, and optionally ``weight``/``cost`` - to sync the
        product's *entire* variant set (see ``_shopify_sync_variants``).
        For a single-variant product, a bare top-level
        ``shopify_variant_id`` (with ``default_code``/``list_price``
        already in ``vals``) still works exactly as before - no
        attribute/variant-list plumbing needed for the common case, and
        existing callers that only ever synced one variant per product
        keep working unchanged.

        Matching order: existing shopify_shop+shopify_id mapping, then
        (for a never-before-seen Shopify ID) default_code/SKU, then - if a
        ``shopify_variant_id`` (or the first entry of ``variants``) is
        given - a product.product already tagged with it. That last one
        matters: an order line for a variant with no SKU gets its product
        created by product.product._shopify_resolve_variant() the first
        time an order for it arrives, tagged only at the variant level.
        Without this check, catalog-syncing that same product afterwards
        would create a second, duplicate product.template instead of
        adopting the one that already exists.

        Returns ``{"action": "created"|"updated", "id": <template id>}``.
        """
        shopify_shop = vals.get("shopify_shop")
        shopify_id = vals.get("shopify_id")
        if not shopify_shop or not shopify_id:
            raise ValidationError("shopify_sync_product requires shopify_shop and shopify_id.")

        variants = list(vals.get("variants") or [])
        shopify_variant_id = vals.get("shopify_variant_id")
        if not variants and shopify_variant_id:
            # Back-compat single-variant shape: vals already carries this
            # variant's own sku/price directly at the top level.
            variants = [
                {
                    "shopify_variant_id": shopify_variant_id,
                    "sku": vals.get("default_code"),
                    "price": vals.get("list_price"),
                    "title": None,
                }
            ]
        lookup_variant_id = shopify_variant_id or (variants[0].get("shopify_variant_id") if variants else None)

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
                key: value
                for key, value in vals.items()
                if key not in ("shopify_variant_id", "variants")
            }
            write_vals["shopify_synced_at"] = fields.Datetime.now()

            if not product and write_vals.get("default_code"):
                product = self.sudo().search(
                    [("default_code", "=", write_vals["default_code"])], limit=1
                )

            if not product and lookup_variant_id:
                existing_variant = self.env["product.product"].sudo().search(
                    [
                        ("shopify_shop", "=", shopify_shop),
                        ("shopify_variant_id", "=", lookup_variant_id),
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

            if len(variants) > 1:
                self._shopify_sync_variants(product, shopify_shop, variants)
            elif variants:
                variant = product.product_variant_ids[:1]
                if variant:
                    self._shopify_tag_variant(
                        variant,
                        shopify_shop,
                        variants[0].get("shopify_variant_id"),
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
