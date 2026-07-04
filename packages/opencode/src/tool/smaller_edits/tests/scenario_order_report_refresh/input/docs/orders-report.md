# Orders report

The reporting package emits two views.

## Detailed report

Each block includes the order id, customer, status, total, and tags.

Example overdue block:

```text
# ord_1002 Acorn Bakery
  status: Overdue
  total: $482.50
  tags: retail
```

## Console report

The console view is a compact pipe-delimited line:

```text
ord_1002 | Acorn Bakery | Overdue | $482.50
```

## Supported statuses

| Internal value | Rendered label |
| --- | --- |
| `draft` | `Draft` |
| `paid` | `Paid` |
| `overdue` | `Overdue` |
| `hold` | `Hold` |
| `refunded` | `Refunded` |
| `cancelled` | `Cancelled` |

Overdue entries are currently rendered the same way in every view.
