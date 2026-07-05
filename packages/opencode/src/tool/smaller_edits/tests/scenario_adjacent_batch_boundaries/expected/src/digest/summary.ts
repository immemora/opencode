export type DigestBucket = "attention" | "watch" | "steady" | "celebrate"

export type DigestItem = {
  id: string
  owner: string
  bucket: DigestBucket
  hoursStale: number
  title: string
  notes: string[]
}

function bucketLabel(bucket: DigestBucket) {
  if (bucket === "attention") return "Needs attention"
  if (bucket === "watch") return "Watch"
  if (bucket === "steady") return "Steady"
  return "Celebrate"
}

function freshnessLabel(hoursStale: number) {
  if (hoursStale <= 6) return "fresh"
  if (hoursStale <= 24) return "aging"
  return "stale"
}

function renderNotes(notes: string[]) {
  if (notes.length === 0) return "none"
  return notes.join("; ")
}

function renderItem(item: DigestItem) {
  return [
    `- ${item.id} ${item.title} [freshness=${freshnessLabel(item.hoursStale)}]`,
    `  owner: ${item.owner}`,
    `  bucket: ${bucketLabel(item.bucket)}`,
    `  notes: ${renderNotes(item.notes)}`,
  ].join("\n")
}

export function renderDigest(items: DigestItem[]) {
  const lines = ["Team digest", "===========", ""]
  for (const item of items) {
    lines.push(renderItem(item))
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderOwnerSummary(items: DigestItem[]) {
  const lines = ["Owner summary", "-------------"]
  for (const item of items) {
    lines.push(`${item.owner}: ${bucketLabel(item.bucket)} -> ${item.title} [freshness=${freshnessLabel(item.hoursStale)}]`)
  }
  return lines.join("\n")
}

export const seedItems: DigestItem[] = [
  {
    id: "dig_201",
    owner: "Ari",
    bucket: "attention",
    hoursStale: 30,
    title: "Reconcile warehouse mismatch",
    notes: ["inventory drift", "vendor pending"],
  },
  {
    id: "dig_202",
    owner: "Marta",
    bucket: "watch",
    hoursStale: 12,
    title: "Monitor onboarding queue",
    notes: ["signup spikes"],
  },
  {
    id: "dig_203",
    owner: "Noah",
    bucket: "steady",
    hoursStale: 4,
    title: "Weekly billing exports",
    notes: ["all green", "finance synced"],
  },
]
