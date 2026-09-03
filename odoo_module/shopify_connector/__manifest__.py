{
    "name": "Shopify Connector",
    "version": "19.0.1.0.0",
    "category": "Sales/Sales",
    "summary": "Odoo-side companion module for the Shopify Connector app: "
                "identity mapping, bulk sync endpoints and sync logs.",
    "description": """
Shopify Connector (Odoo side)
==============================

This module is the Odoo-side half of the *odoo-connector* Shopify app. It
does not talk to Shopify directly - the Shopify app calls into it through
Odoo's built-in External API (``/json/2/<model>/<method>``, the same
endpoint the app's ``OdooClient`` already uses), authenticated with a
Bearer API key issued to a dedicated technical user.

What it adds on top of stock Odoo:

* ``shopify_id`` / ``shopify_shop`` identity fields (indexed, unique per
  shop) on ``product.template``, ``product.product``, ``res.partner`` and
  ``sale.order``, so records are matched by ID instead of by guessing from
  SKU/email on every call.
* One RPC method per resource (``shopify_sync_product``,
  ``shopify_sync_customer``, ``shopify_sync_order``) that performs the
  full upsert - including, for orders, the customer and every line item -
  inside a single Odoo transaction. This is what collapses the app's
  current N+1 calls per order into one round trip.
* ``shopify_location_id`` on ``stock.warehouse`` plus a
  ``shopify_stock_snapshot`` method, so the app can pull authoritative
  Odoo stock levels per Shopify location for reconciliation.
* A ``shopify.sync.log`` model recording every call's outcome, giving
  Odoo admins the same visibility the app's own sync log gives merchants.
* Automatic invoicing for paid orders: a Shopify order marked PAID gets
  invoiced, the invoice posted, and a payment registered against a
  dedicated "Shopify Payments" clearing journal - not just confirmed with
  no accounting trail at all, which was the previous behaviour.

See ``README.md`` in this module for setup (creating the technical user
and API key) and the security model.
""",
    "author": "Cybrosys Technologies",
    "website": "https://www.cybrosys.com",
    "license": "LGPL-3",
    "depends": ["sale_management", "stock"],
    "data": [
        "security/shopify_connector_security.xml",
        "security/ir.model.access.csv",
        "views/shopify_sync_log_views.xml",
        "views/stock_warehouse_views.xml",
        "views/res_company_views.xml",
        "views/account_journal_views.xml",
    ],
    "installable": True,
    "application": False,
    "auto_install": False,
}
