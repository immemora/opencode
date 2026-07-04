export type IncidentSeverity = "sev0" | "sev1" | "sev2" | "sev3"

export type TimelineItem = {
  at: string
  title: string
  severity: IncidentSeverity
  audience: "internal" | "customer" | "partner"
  resolved: boolean
  detail: string
}

function timelineSeverity(severity: IncidentSeverity) {
  if (severity === "sev0") return "Sev0"
  if (severity === "sev1") return "Sev1"
  if (severity === "sev2") return "Sev2"
  return "Sev3"
}

function audienceTitle(audience: TimelineItem["audience"]) {
  if (audience === "internal") return "Internal"
  if (audience === "customer") return "Customer"
  return "Partner"
}

function resolutionState(resolved: boolean) {
  return resolved ? "closed" : "open"
}

export function renderTimeline(items: TimelineItem[]) {
  const lines = ["Incident timeline", "================="]
  for (const item of items) {
    lines.push(`${item.at} :: ${timelineSeverity(item.severity)} :: ${item.title}`)
    lines.push(`audience=${audienceTitle(item.audience)} status=${resolutionState(item.resolved)}`)
    lines.push(item.detail)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderAudienceSummary(items: TimelineItem[]) {
  return items.map((item) => `${audienceTitle(item.audience)} -> ${item.title}`).join("\n")
}

export const seedTimeline: TimelineItem[] = [
  {
    at: "2026-06-01T08:15:00Z",
    title: "API latency spike",
    severity: "sev1",
    audience: "customer",
    resolved: false,
    detail: "Requests in eu-west crossed the paging threshold.",
  },
  {
    at: "2026-06-01T08:42:00Z",
    title: "Background job backlog",
    severity: "sev2",
    audience: "internal",
    resolved: false,
    detail: "Queue workers saturated after the retry burst.",
  },
  {
    at: "2026-06-01T09:05:00Z",
    title: "Partner webhook retries",
    severity: "sev3",
    audience: "partner",
    resolved: true,
    detail: "Delivery recovered after rotating the stale endpoint certificate.",
  },
]
