export type RunbookSection = "prepare" | "verify" | "rollback" | "followup"

export type RunbookStep = {
  id: string
  title: string
  section: RunbookSection
  priority: number
  owner: string
  notes: string[]
}

function sectionLabel(section: RunbookSection) {
  if (section === "prepare") return "Prepare"
  if (section === "verify") return "Verify"
  if (section === "rollback") return "Roll back"
  return "Follow up"
}

function priorityLabel(priority: number) {
  if (priority === 1) return "urgent"
  if (priority === 2) return "high"
  if (priority === 3) return "normal"
  return "deferred"
}

function noteList(notes: string[]) {
  if (notes.length === 0) return "none"
  return notes.join(", ")
}

export function renderOutline(steps: RunbookStep[]) {
  const lines = ["Runbook outline", "==============="]
  for (const step of steps) {
    lines.push(`${step.id} ${sectionLabel(step.section)} [priority=${priorityLabel(step.priority)}] :: ${step.title}`)
    lines.push(`owner=${step.owner}`)
    lines.push(`notes=${noteList(step.notes)}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderSectionSummary(steps: RunbookStep[]) {
  return steps.map((step) => `${sectionLabel(step.section)} -> ${step.title}`).join("\n")
}

export const seedSteps: RunbookStep[] = [
  {
    id: "rb_01",
    title: "Warm replica connections",
    section: "prepare",
    priority: 2,
    owner: "Platform",
    notes: ["keep under threshold", "verify connection pool"],
  },
  {
    id: "rb_02",
    title: "Check canary error budget",
    section: "verify",
    priority: 1,
    owner: "Observability",
    notes: ["latency", "error rate"],
  },
  {
    id: "rb_03",
    title: "Revert traffic slice",
    section: "rollback",
    priority: 1,
    owner: "Release",
    notes: ["announce in chat"],
  },
  {
    id: "rb_04",
    title: "Collect operator notes",
    section: "followup",
    priority: 4,
    owner: "Program",
    notes: ["retro inputs", "ticket links"],
  },
]
