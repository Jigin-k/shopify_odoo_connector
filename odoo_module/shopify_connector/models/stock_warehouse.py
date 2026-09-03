from odoo import fields, models


class StockWarehouse(models.Model):
    _inherit = "stock.warehouse"

    shopify_location_id = fields.Char(
        string="Shopify Location ID",
        index=True,
        copy=False,
        help="ID of the Shopify location whose stock this warehouse "
        "reports to Shopify via product.product.shopify_stock_snapshot(). "
        "Leave empty for warehouses that should not be exposed to Shopify.",
    )
