# Incident communication

The incident package renders timeline entries and outbound email messages.

## Shared helper file

Common labels now live in `src/incidents/templates.ts` and are consumed by both the timeline and email modules.

## Severity labels

| Code | Label |
| --- | --- |
| `sev0` | `Critical` |
| `sev1` | `High` |
| `sev2` | `Moderate` |
| `sev3` | `Low` |

## Audience labels

| Code | Label |
| --- | --- |
| `internal` | `Internal` |
| `customer` | `Customer` |
| `partner` | `Partner` |

## Resolution labels

`true` renders as `Resolved` and `false` renders as `Open`.

## Subject example

```text
High incident update: API latency spike
```

## Timeline example

```text
2026-06-01T08:15:00Z :: High / Open :: API latency spike
audience=Customer status=Open
Requests in eu-west crossed the paging threshold.
```

Audience summary lines now use `Customer audience`, `Internal audience`, or `Partner audience` wording.
