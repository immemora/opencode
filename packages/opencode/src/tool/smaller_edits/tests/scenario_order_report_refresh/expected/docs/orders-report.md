# Orders report

The reporting package emits two views.

## Detailed report

Each block includes the order id, customer, status, total, and tags.

Example overdue block:

```text
# ord_1002 Acorn Bakery
  status: Overdue (3 days overdue)
  total: $482.50
  tags: retail
```

## Console report

The console view is a compact pipe-delimited line:

```text
ord_1002 | Acorn Bakery | Overdue | $482.50 overdue=3d
```

## Supported statuses

| Internal value | Rendered label |
| --- | --- |
| `draft` | `Draft` |
| `paid` | `Paid` |
| `overdue` | `Overdue` |
| `hold` | `On hold` |
| `refunded` | `Refunded` |
| `cancelled` | `Cancelled` |

Overdue entries include aging details in the detailed view and an `overdue=<days>d` suffix in the console view when the overdue age is greater than zero.
