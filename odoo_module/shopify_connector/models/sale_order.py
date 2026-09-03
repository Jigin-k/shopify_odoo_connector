from odoo import api, fields, models
from odoo.exceptions import ValidationError

PAID_STATUSES = {"PAID", "PARTIALLY_REFUNDED"}
# Only a clean, fully-collected PAID triggers automatic invoicing +
# payment registration. PARTIALLY_REFUNDED still confirms the order (a
# refund doesn't undo the sale) but the actually-collected amount no
# longer matches the order total, and building correct partial-payment/
# credit-note handling is a distinct feature - out of scope for now, so
# that case is left invoiced manually.
INVOICE_AND_PAY_STATUSES = {"PAID"}


class SaleOrder(models.Model):
    _name = "sale.order"
    _inherit = ["sale.order", "shopify.sync.mixin"]

    shopify_id = fields.Char(string="Shopify Order ID", index=True, copy=False)
    shopify_shop = fields.Char(string="Shopify Shop", index=True, copy=False)
    shopify_name = fields.Char(string="Shopify Order #", copy=False)

    _shopify_id_shop_uniq = models.Constraint(
        "unique(shopify_shop, shopify_id)",
        "A Shopify order can only be mapped to one Odoo sales order per shop.",
    )

    @api.model
    def _shopify_order_line_commands(self, shopify_shop, order, lines_vals, taxes_included):
        """Build one2many commands that add/update lines without ever
        deleting one from an already-confirmed order.

        Odoo refuses to remove a line once a sales order is confirmed
        (``sale.order.line._unlink_except_confirmed``, since something may
        already be invoiced/delivered against it) - wiping and recreating
        every line on each resync, as the app's own current TypeScript
        order sync does, works once but raises a UserError on the very
        next resync of a paid order. Matching existing lines by product
        and updating in place avoids that: (1, id, vals) instead of
        (5, 0, 0) + (0, 0, vals) for anything already there.
        """
        existing_by_product = {
            line.product_id.id: line for line in order.order_line if line.product_id
        }
        seen_product_ids = set()
        commands = []

        for line in lines_vals:
            variant = self.env["product.product"]._shopify_resolve_variant(shopify_shop, line)
            seen_product_ids.add(variant.id)
            line_vals = {
                "product_id": variant.id,
                "name": line.get("title") or variant.display_name,
                "product_uom_qty": line.get("quantity") or 1,
                "price_unit": line.get("price") or 0.0,
                # Explicit, even when empty: an untaxed Shopify line must
                # not silently pick up the product's own default taxes.
                "tax_ids": [
                    (
                        6,
                        0,
                        self.env["account.tax"]._shopify_resolve_tax_lines(
                            line.get("tax_lines"), taxes_included
                        ),
                    )
                ],
            }
            existing_line = existing_by_product.get(variant.id)
            commands.append(
                (1, existing_line.id, line_vals) if existing_line else (0, 0, line_vals)
            )

        # Only drop lines Shopify no longer sends while the order is still
        # mutable (draft/sent). Once confirmed, leave them - a merchant can
        # zero the quantity by hand; this only matters for the rare case of
        # an order edited in Shopify after Odoo already confirmed it.
        if not order or order.state in ("draft", "sent"):
            commands = [
                (2, line.id)
                for product_id, line in existing_by_product.items()
                if product_id not in seen_product_ids
            ] + commands

        return commands

    @api.model
    def _shopify_register_payment(self, moves):
        """Register a payment against posted, not-yet-settled account.move
        records via the Shopify Payments clearing journal.

        Shared by the invoice-paid flow and the credit-note flow below:
        Odoo's payment register wizard already handles the inbound-vs-
        outbound direction correctly based on the move's own type/sign
        (a credit note gets a refund, an invoice gets a payment), so
        there's nothing move-type-specific to do here.
        """
        unsettled = moves.filtered(
            lambda m: m.state == "posted" and m.payment_state not in ("paid", "in_payment", "reversed")
        )
        if not unsettled:
            return

        journal = self.env["account.journal"]._shopify_get_payments_journal()
        wizard = (
            self.env["account.payment.register"]
            .with_context(active_model="account.move", active_ids=unsettled.ids)
            .create({"journal_id": journal.id})
        )
        wizard._create_payments()

    def _shopify_invoice_and_register_payment(self):
        """Invoice this order and mark it paid, mirroring Shopify having
        already collected the money.

        Confirming a sale order does not create, post, or pay any invoice
        on its own - those are three separate Odoo steps
        (``_create_invoices`` -> ``action_post`` -> registering a
        payment). Without this, a Shopify order marked PAID would sit in
        Odoo confirmed but with no invoice at all, understating both
        revenue and what the customer has actually paid.

        Idempotent: safe to call on every resync of an already-paid
        order (create/updated/paid webhooks all re-run the full sync) -
        it only invoices what isn't invoiced yet and only pays what
        isn't paid yet.
        """
        self.ensure_one()
        if self.invoice_status != "invoiced":
            invoices = self._create_invoices()
            invoices.filtered(lambda inv: inv.state == "draft").action_post()

        self._shopify_register_payment(self.invoice_ids)

    @api.model
    def shopify_sync_refund(self, vals):
        """Create a credit note for a Shopify refund and register the
        money going back out, mirroring _shopify_invoice_and_register_
        payment's logic for the reverse direction.

        Expected ``vals``::

            {
              "shopify_shop": str, "shopify_order_id": str,
              "shopify_refund_id": str,
              "lines": [{"shopify_variant_id", "sku", "title",
                         "quantity"}, ...],
            }

        Each refunded line is matched back to the *original* sale.order.
        line for that product and its exact price_unit/tax_ids are
        reused, rather than recomputing them from Shopify's own subtotal/
        tax breakdown - avoids rounding drift between what Shopify
        reports and what Odoo already has on record for that line, and a
        line refunded for a product this order never actually had (which
        shouldn't happen, but webhooks can carry surprises) is skipped
        rather than guessed at.

        Idempotent via ``shopify_refund_id``: a redelivered webhook for
        the same refund is a no-op, not a duplicate credit note.
        """
        shopify_shop = vals.get("shopify_shop")
        shopify_order_id = vals.get("shopify_order_id")
        shopify_refund_id = vals.get("shopify_refund_id")
        if not (shopify_shop and shopify_order_id and shopify_refund_id):
            raise ValidationError(
                "shopify_sync_refund requires shopify_shop, shopify_order_id and shopify_refund_id."
            )

        def _do():
            existing = self.env["account.move"].sudo().search(
                [("shopify_refund_id", "=", shopify_refund_id)], limit=1
            )
            if existing:
                return {"action": "skipped", "id": existing.id, "model": "account.move"}

            order = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_order_id)],
                limit=1,
            )
            if not order:
                raise ValidationError(
                    f"No Odoo order mapped for Shopify order {shopify_order_id} - "
                    "sync the order itself before its refund."
                )

            invoiced = order.invoice_ids.filtered(
                lambda inv: inv.state == "posted" and inv.move_type == "out_invoice"
            )
            if not invoiced:
                # Nothing invoiced yet to credit against (e.g. a refund
                # arriving for an order that was never marked paid) -
                # nothing for a credit note to reverse.
                return {"action": "skipped", "id": False, "model": "account.move"}

            credit_line_vals = []
            for refund_line in vals.get("lines") or []:
                qty = refund_line.get("quantity") or 0
                if not qty:
                    continue
                variant = self.env["product.product"]._shopify_resolve_variant(
                    shopify_shop, refund_line
                )
                order_line = order.order_line.filtered(
                    lambda line, v=variant: line.product_id.id == v.id
                )[:1]
                if not order_line:
                    continue
                credit_line_vals.append(
                    (
                        0,
                        0,
                        {
                            "product_id": variant.id,
                            "quantity": qty,
                            "price_unit": order_line.price_unit,
                            "tax_ids": [(6, 0, order_line.tax_ids.ids)],
                        },
                    )
                )

            if not credit_line_vals:
                return {"action": "skipped", "id": False, "model": "account.move"}

            credit_note = self.env["account.move"].sudo().create(
                {
                    "move_type": "out_refund",
                    "partner_id": order.partner_id.id,
                    "invoice_origin": order.shopify_name or order.name,
                    "ref": f"Shopify refund for order {order.shopify_name or order.name}",
                    "shopify_refund_id": shopify_refund_id,
                    "invoice_line_ids": credit_line_vals,
                }
            )
            credit_note.action_post()
            self._shopify_register_payment(credit_note)

            return {"action": "created", "id": credit_note.id, "model": "account.move"}

        return self._shopify_sync_call(
            resource_type="order",
            shopify_shop=shopify_shop,
            shopify_id=shopify_refund_id,
            method="shopify_sync_refund",
            func=_do,
        )

    @api.model
    def shopify_sync_order(self, vals):
        """Create/update an order - customer, every line, and workflow
        state - in one RPC call and one transaction.

        This is the main reliability/speed win over the app's current
        order sync, which makes one Odoo call per line item plus separate
        customer/order/workflow calls (12+ round trips for a 10-line
        order). Here it is 1.

        Expected ``vals``::

            {
              "shopify_shop": str, "shopify_id": str, "name": str,
              "customer": {<same shape as shopify_sync_customer, minus
                            shopify_shop>},
              "lines": [{"title", "sku", "shopify_variant_id", "quantity",
                         "price", "tax_lines": [{"title", "rate"}, ...]},
                        ...],
              "taxes_included": bool,
              "financial_status": "PAID" | ..., "cancelled": bool,
              "note": str,
            }

        ``taxes_included`` and each line's ``tax_lines`` come straight
        from Shopify and are mapped to actual Odoo taxes (see
        account.tax._shopify_resolve_tax_lines) rather than letting each
        line fall back to its product's own default tax - see that
        method's docstring for why that fallback is wrong here.

        A missing ``customer`` (guest checkout) still needs a partner in
        Odoo; the caller should send a synthetic id such as
        ``guest:<shopify_id>`` as ``customer.shopify_id``.
        """
        shopify_shop = vals.get("shopify_shop")
        shopify_id = vals.get("shopify_id")
        if not shopify_shop or not shopify_id:
            raise ValidationError("shopify_sync_order requires shopify_shop and shopify_id.")
        if not vals.get("lines"):
            raise ValidationError("shopify_sync_order requires at least one line item.")

        def _do():
            customer_vals = dict(vals.get("customer") or {}, shopify_shop=shopify_shop)
            customer_vals.setdefault("shopify_id", f"guest:{shopify_id}")
            partner_result = self.env["res.partner"].shopify_sync_customer(customer_vals)

            order = self.sudo().search(
                [("shopify_shop", "=", shopify_shop), ("shopify_id", "=", shopify_id)],
                limit=1,
            )

            order_vals = {
                "partner_id": partner_result["id"],
                "client_order_ref": vals.get("name"),
                "origin": f"Shopify {vals.get('name') or shopify_id}",
                "note": vals.get("note") or False,
                "order_line": self._shopify_order_line_commands(
                    shopify_shop, order, vals["lines"], bool(vals.get("taxes_included"))
                ),
            }

            # Persist the identity before workflow actions so a failed
            # confirm/cancel can be retried without creating a duplicate
            # order - same reasoning as the app's own saveMapping-before-
            # workflow-actions ordering.
            if order:
                order.write(order_vals)
                action = "updated"
            else:
                order_vals.update(
                    shopify_shop=shopify_shop,
                    shopify_id=shopify_id,
                    shopify_name=vals.get("name"),
                )
                order = self.sudo().create(order_vals)
                action = "created"

            financial_status = (vals.get("financial_status") or "").upper()

            if vals.get("cancelled"):
                if order.state != "cancel":
                    order.action_cancel()
            else:
                if financial_status in PAID_STATUSES and order.state in ("draft", "sent"):
                    order.action_confirm()
                if financial_status in INVOICE_AND_PAY_STATUSES and order.state == "sale":
                    order._shopify_invoice_and_register_payment()

            return {"action": action, "id": order.id, "model": "sale.order"}

        return self._shopify_sync_call(
            resource_type="order",
            shopify_shop=shopify_shop,
            shopify_id=shopify_id,
            method="shopify_sync_order",
            func=_do,
        )
