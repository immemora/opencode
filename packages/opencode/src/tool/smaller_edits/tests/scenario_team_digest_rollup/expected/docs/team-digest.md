# Team digest

The team digest surfaces a short set of priorities for daily review.

## Primary labels

- `attention` renders as `Needs attention`
- `watch` renders as `Watch`
- `steady` renders as `Steady`
- `celebrate` renders as `Celebrate`

## Freshness labels

- `<= 6 hours` -> `fresh`
- `<= 24 hours` -> `aging`
- `> 24 hours` -> `stale`

## Full digest example

```text
- dig_201 Reconcile warehouse mismatch
  owner: Ari
  bucket: Needs attention [freshness=stale]
  notes: inventory drift; vendor pending
```

## Compact deck example

```text
Needs attention :: Ari :: Reconcile warehouse mismatch stale=30h
Watch :: Marta :: Monitor onboarding queue
```

Items now carry freshness labels in the full digest and owner summary. Compact cards add a `stale=<hours>h` suffix only for items older than 24 hours.
