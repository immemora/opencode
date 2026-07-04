export type IncidentSeverity = "sev0" | "sev1" | "sev2" | "sev3"
export type IncidentAudience = "internal" | "customer" | "partner"

export function severityLabel(severity: IncidentSeverity) {
  if (severity === "sev0") return "Critical"
  if (severity === "sev1") return "High"
  if (severity === "sev2") return "Moderate"
  return "Low"
}

export function audienceLabel(audience: IncidentAudience) {
  if (audience === "internal") return "Internal"
  if (audience === "customer") return "Customer"
  return "Partner"
}

export function resolutionLabel(resolved: boolean) {
  return resolved ? "Resolved" : "Open"
}
