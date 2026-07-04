import type { DigestBucket, DigestItem } from "./summary"

function bucketToken(bucket: DigestBucket) {
  if (bucket === "attention") return "Attention"
  if (bucket === "watch") return "Watch"
  if (bucket === "steady") return "Steady"
  return "Celebrate"
}

export function renderCompactCard(item: DigestItem) {
  return `${bucketToken(item.bucket)} :: ${item.owner} :: ${item.title}`
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
    lines.push(bucketToken(bucket))
    for (const item of bucketItems) {
      lines.push(`- ${item.owner}: ${item.title}`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
