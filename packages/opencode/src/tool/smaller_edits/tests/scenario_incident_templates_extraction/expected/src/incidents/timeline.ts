import { audienceLabel, resolutionLabel, severityLabel, type IncidentAudience, type IncidentSeverity } from "./templates"

export type { IncidentSeverity }

export type TimelineItem = {
  at: string
  title: string
  severity: IncidentSeverity
  audience: IncidentAudience
  resolved: boolean
  detail: string
}

export function renderTimeline(items: TimelineItem[]) {
  const lines = ["Incident timeline", "================="]
  for (const item of items) {
    lines.push(`${item.at} :: ${severityLabel(item.severity)} / ${resolutionLabel(item.resolved)} :: ${item.title}`)
    lines.push(`audience=${audienceLabel(item.audience)} status=${resolutionLabel(item.resolved)}`)
    lines.push(item.detail)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderAudienceSummary(items: TimelineItem[]) {
  return items.map((item) => `${audienceLabel(item.audience)} audience -> ${item.title}`).join("\n")
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
