# Runbook outline

This package renders a textual outline and a compact card deck.

## Section labels

| Internal | Rendered |
| --- | --- |
| `prepare` | `Prepare` |
| `verify` | `Verify` |
| `rollback` | `Roll back` |
| `followup` | `Follow up` |

## Priority labels

| Priority | Rendered |
| --- | --- |
| `1` | `urgent` |
| `2` | `high` |
| `3` | `normal` |
| other | `deferred` |

## Outline example

```text
rb_02 Verify [priority=urgent] :: Check canary error budget
owner=Observability
notes=latency, error rate
```

## Card example

```text
Verify :: Check canary error budget :: Observability :: priority=urgent
```

Priority values are now rendered in both views.
