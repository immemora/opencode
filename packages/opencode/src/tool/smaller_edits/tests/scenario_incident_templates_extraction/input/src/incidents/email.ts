import type { IncidentSeverity, TimelineItem } from "./timeline"

export type IncidentMail = {
  title: string
  severity: IncidentSeverity
  audience: "internal" | "customer" | "partner"
  body: string[]
}

function subjectSeverity(severity: IncidentSeverity) {
  if (severity === "sev0") return "Sev0"
  if (severity === "sev1") return "Sev1"
  if (severity === "sev2") return "Sev2"
  return "Sev3"
}

function audienceHeading(audience: IncidentMail["audience"]) {
  if (audience === "internal") return "Internal"
  if (audience === "customer") return "Customer"
  return "Partner"
}

export function renderSubject(incident: IncidentMail) {
  return `${subjectSeverity(incident.severity)} update: ${incident.title}`
}

export function renderBody(incident: IncidentMail) {
  const lines = [
    `${audienceHeading(incident.audience)} update`,
    "",
    ...incident.body,
  ]
  return lines.join("\n")
}

export function renderDigestMail(items: TimelineItem[]) {
  return items
    .map((item) => `${subjectSeverity(item.severity)} | ${audienceHeading(item.audience)} | ${item.title}`)
    .join("\n")
}
