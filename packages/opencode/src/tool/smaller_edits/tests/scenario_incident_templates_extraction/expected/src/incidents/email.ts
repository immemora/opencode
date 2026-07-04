import { audienceLabel, severityLabel, type IncidentAudience, type IncidentSeverity } from "./templates"
import type { TimelineItem } from "./timeline"

export type IncidentMail = {
  title: string
  severity: IncidentSeverity
  audience: IncidentAudience
  body: string[]
}

export function renderSubject(incident: IncidentMail) {
  return `${severityLabel(incident.severity)} incident update: ${incident.title}`
}

export function renderBody(incident: IncidentMail) {
  const lines = [
    `${audienceLabel(incident.audience)} audience update`,
    "",
    ...incident.body,
  ]
  return lines.join("\n")
}

export function renderDigestMail(items: TimelineItem[]) {
  return items.map((item) => `${severityLabel(item.severity)} | ${audienceLabel(item.audience)} audience | ${item.title}`).join("\n")
}
