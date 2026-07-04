# Incident communication

The incident package renders timeline entries and outbound email messages.

## Severity labels

| Code | Label |
| --- | --- |
| `sev0` | `Sev0` |
| `sev1` | `Sev1` |
| `sev2` | `Sev2` |
| `sev3` | `Sev3` |

## Audience labels

| Code | Label |
| --- | --- |
| `internal` | `Internal` |
| `customer` | `Customer` |
| `partner` | `Partner` |

## Subject example

```text
Sev1 update: API latency spike
```

## Timeline example

```text
2026-06-01T08:15:00Z :: Sev1 :: API latency spike
audience=Customer status=open
Requests in eu-west crossed the paging threshold.
```

The timeline and email modules currently carry their own label branches.
