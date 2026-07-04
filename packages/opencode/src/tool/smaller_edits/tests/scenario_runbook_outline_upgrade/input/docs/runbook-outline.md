# Runbook outline

This package renders a textual outline and a compact card deck.

## Section labels

| Internal | Rendered |
| --- | --- |
| `prepare` | `Prepare` |
| `verify` | `Verify` |
| `rollback` | `Rollback` |
| `followup` | `Followup` |

## Outline example

```text
rb_02 Verify :: Check canary error budget
owner=Observability
notes=latency, error rate
```

## Card example

```text
Check canary error budget :: Verify :: Observability
```

Priority values are currently not rendered.
