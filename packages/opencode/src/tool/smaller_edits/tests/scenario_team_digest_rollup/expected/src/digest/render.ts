import type { DigestBucket, DigestItem } from "./summary"

function bucketLabel(bucket: DigestBucket) {
  if (bucket === "attention") return "Needs attention"
  if (bucket === "watch") return "Watch"
  if (bucket === "steady") return "Steady"
  return "Celebrate"
}

function staleSuffix(item: DigestItem) {
  if (item.hoursStale <= 24) return ""
  return ` stale=${item.hoursStale}h`
}

export function renderCompactCard(item: DigestItem) {
  return `${bucketLabel(item.bucket)} :: ${item.owner} :: ${item.title}${staleSuffix(item)}`
}

export function renderCompactDeck(items: DigestItem[]) {
  return items.map(renderCompactCard).join("\n")
}

export function renderBucketGroups(items: DigestItem[]) {
  const groups = [
    ["attention", items.filter((item) => item.bucket === "attention")],
    ["watch", items.filter((item) => item.bucket === "watch")],
    ["steady", items.filter((item) => item.bucket === "steady")],
    ["celebrate", items.filter((item) => item.bucket === "celebrate")],
  ] as const

  const lines: string[] = []
  for (const [bucket, bucketItems] of groups) {
    lines.push(bucketLabel(bucket))
    for (const item of bucketItems) {
      lines.push(`- ${item.owner}: ${item.title}${staleSuffix(item)}`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
