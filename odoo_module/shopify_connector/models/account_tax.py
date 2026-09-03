from odoo import api, models

# account.tax.amount stores 4 decimal digits - matches Shopify's own tax
# rate precision closely enough that rounding here won't create spurious
# near-duplicate tax records for the same real-world rate.
TAX_RATE_PRECISION = 4


class AccountTax(models.Model):
    _inherit = "account.tax"

    @api.model
    def _shopify_resolve_tax_lines(self, tax_lines, taxes_included):
        """Find or create the Odoo sales tax(es) matching a Shopify order
        line's own tax_lines, instead of letting the order line fall back
        to the product's default taxes.

        That fallback is what caused the original bug this method fixes:
        Shopify's line price already reflects whatever tax was actually
        charged (or already includes it, per ``taxes_included``), but
        Odoo has no way to know that unless a tax is explicitly assigned
        - left alone, it applies the product's own default tax on top of
        a price that was never meant to be taxed again, inflating the
        order total above what Shopify actually collected.

        ``tax_lines``: Shopify's own shape, e.g.
        ``[{"title": "State Tax", "rate": 0.06}, ...]`` - a line can carry
        more than one (state + county + city, common in the US).
        ``taxes_included``: the order-level flag from Shopify saying
        whether line prices already include tax; determines whether the
        matched/created Odoo tax is marked Tax Included or Tax Excluded,
        so Odoo's own total calculation agrees with Shopify's regardless
        of which way the merchant's Shopify store is configured.

        Returns a list of ``account.tax`` ids for a ``(6, 0, ids)``
        command; empty for an untaxed line (Shopify sent no tax_lines) -
        deliberately not the product's default in that case either.
        """
        price_include_override = "tax_included" if taxes_included else "tax_excluded"
        tax_ids = []

        for tax_line in tax_lines or []:
            rate = round(float(tax_line.get("rate") or 0.0) * 100, TAX_RATE_PRECISION)
            if not rate:
                continue

            tax = self.sudo().search(
                [
                    ("type_tax_use", "=", "sale"),
                    ("amount", "=", rate),
                    ("price_include_override", "=", price_include_override),
                ],
                limit=1,
            )
            if not tax:
                title = tax_line.get("title") or "Tax"
                tax = self.sudo().create(
                    {
                        "name": f"{title} ({rate}%) [Shopify]",
                        "amount": rate,
                        "type_tax_use": "sale",
                        "price_include_override": price_include_override,
                    }
                )
            tax_ids.append(tax.id)

        return tax_ids
