from odoo import api, fields, models


class AccountJournal(models.Model):
    _inherit = "account.journal"

    shopify_is_payments_journal = fields.Boolean(
        string="Shopify Payments Clearing Journal",
        copy=False,
        help="Marks the journal sale.order._shopify_invoice_and_register_payment() "
        "registers Shopify-paid orders' payments against. At most one "
        "journal should have this set - if you'd rather route these "
        "payments through a journal you already have (e.g. an existing "
        "Stripe/PayPal journal), move the flag there instead of letting a "
        "new one be auto-created.",
    )

    @api.model
    def _shopify_get_payments_journal(self):
        """Find (or create) the clearing journal for Shopify payments.

        Shopify collects payment from the customer immediately but doesn't
        pay it out to the merchant's real bank account until its own
        payout schedule runs. Registering the payment straight against a
        real bank journal would overstate that account's balance until
        the payout actually lands days later. A dedicated journal keeps
        Shopify-collected funds visible and separate until reconciled
        against the real payout deposit - the same pattern used for any
        payment processor that holds funds before payout.
        """
        journal = self.sudo().search([("shopify_is_payments_journal", "=", True)], limit=1)
        if journal:
            return journal
        return self.sudo().create(
            {
                "name": "Shopify Payments",
                "type": "bank",
                "shopify_is_payments_journal": True,
            }
        )
