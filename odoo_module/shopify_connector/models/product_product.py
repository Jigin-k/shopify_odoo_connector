from odoo import api, fields, models


class ProductProduct(models.Model):
    _inherit = "product.product"

    shopify_variant_id = fields.Char(string="Shopify Variant ID", index=True, copy=False)
    shopify_shop = fields.Char(string="Shopify Shop", index=True, copy=False)

    _shopify_variant_id_shop_uniq = models.Constraint(
        "unique(shopify_shop, shopify_variant_id)",
        "A Shopify variant can only be mapped to one Odoo product variant per shop.",
    )

    @api.model
    def _shopify_resolve_variant(self, shopify_shop, line):
        """Find or create the variant an order line refers to.

        Called internally by ``sale.order.shopify_sync_order`` - this is
        what lets a full order (customer + every line) resolve inside a
        single RPC call instead of the app looking up or creating each
        product with its own round trip first.

        Matching order: Shopify variant ID mapping, then SKU/default_code,
        then a bare new template+variant so the order can still be booked
        even for a line Shopify never sent product data for.
        """
        variant_id = line.get("shopify_variant_id")
        sku = line.get("sku") or False

        variant = self.browse()
        if variant_id:
            variant = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_variant_id", "=", variant_id)],
                limit=1,
            )
        if not variant and sku:
            variant = self.sudo().search([("default_code", "=", sku)], limit=1)

        if variant:
            if variant_id and not variant.shopify_variant_id:
                variant.write({"shopify_variant_id": variant_id, "shopify_shop": shopify_shop})
            return variant

        template = self.env["product.template"].sudo().create(
            {
                "name": line.get("title") or sku or f"Shopify item {variant_id or ''}".strip(),
                "default_code": sku,
                "list_price": line.get("price") or 0.0,
            }
        )
        variant = template.product_variant_ids[:1]
        if variant_id:
            variant.write({"shopify_variant_id": variant_id, "shopify_shop": shopify_shop})
        return variant

    @api.model
    def shopify_stock_snapshot(self, shopify_shop, updated_since=None):
        """Available quantity per mapped Shopify location, for the app's
        scheduled inventory pull - Odoo is inventory's source of truth,
        so the app calls this on a timer rather than Odoo pushing to it.

        Only variants and warehouses already mapped to Shopify are
        considered. ``updated_since`` (ISO datetime) is an optimization,
        not a filter on the reported number: it only narrows down *which*
        variants had any quant activity since the last successful pull,
        so an idle catalog doesn't get fully recomputed every poll. Once
        a variant is selected, its reported ``available`` is always the
        true total across every quant under the warehouse - if it were
        computed only from the *recently changed* quants, a variant whose
        stock spans several sub-locations (with only one touched
        recently) would report a wrong, partial figure instead of what's
        actually available.
        """
        warehouses = self.env["stock.warehouse"].sudo().search([("shopify_location_id", "!=", False)])
        if not warehouses:
            return []

        variants = self.sudo().search(
            [("shopify_shop", "=", shopify_shop), ("shopify_variant_id", "!=", False)]
        )
        if not variants:
            return []

        quant_model = self.env["stock.quant"].sudo()
        rows = []
        for warehouse in warehouses:
            base_domain = [
                ("product_id", "in", variants.ids),
                ("location_id", "child_of", warehouse.lot_stock_id.id),
            ]
            if updated_since:
                changed_product_ids = quant_model.search(
                    base_domain + [("write_date", ">=", updated_since)]
                ).product_id.ids
                if not changed_product_ids:
                    continue
                quants = quant_model.search(
                    [
                        ("product_id", "in", changed_product_ids),
                        ("location_id", "child_of", warehouse.lot_stock_id.id),
                    ]
                )
            else:
                quants = quant_model.search(base_domain)

            totals = {}
            for quant in quants:
                totals[quant.product_id.id] = (
                    totals.get(quant.product_id.id, 0.0) + quant.quantity - quant.reserved_quantity
                )

            for product_id, available in totals.items():
                variant = variants.browse(product_id)
                rows.append(
                    {
                        "shopify_location_id": warehouse.shopify_location_id,
                        "shopify_variant_id": variant.shopify_variant_id,
                        "sku": variant.default_code,
                        "available": available,
                    }
                )
        return rows
