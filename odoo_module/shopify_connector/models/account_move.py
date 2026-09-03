from odoo import fields, models


class AccountMove(models.Model):
    _inherit = "account.move"

    shopify_refund_id = fields.Char(
        string="Shopify Refund ID",
        index=True,
        copy=False,
        help="Set on the credit note created for a Shopify refunds/create "
        "webhook - lets sale.order.shopify_sync_refund() recognize a "
        "redelivered webhook for the same refund instead of creating a "
        "second credit note for it.",
    )

    _shopify_refund_id_uniq = models.Constraint(
        "unique(shopify_refund_id)",
        "A Shopify refund can only be mapped to one Odoo credit note.",
    )
