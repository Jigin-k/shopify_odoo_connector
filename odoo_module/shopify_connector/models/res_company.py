from odoo import fields, models


class ResCompany(models.Model):
    _inherit = "res.company"

    shopify_shop_domain = fields.Char(
        string="Shopify Shop",
        copy=False,
        help="The myshopify.com domain synchronizing into this company, "
        "e.g. my-store.myshopify.com. Reference only - the Shopify app "
        "passes its own shop domain with every call; this field just lets "
        "Odoo admins see which store a given company is paired with when "
        "more than one shop feeds the same Odoo database.",
    )
