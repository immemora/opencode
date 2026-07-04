import type { RunbookSection, RunbookStep } from "./outline"

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

export function renderCard(step: RunbookStep) {
  return `${sectionLabel(step.section)} :: ${step.title} :: ${step.owner} :: priority=${priorityLabel(step.priority)}`
}

export function renderDeck(steps: RunbookStep[]) {
  return steps.map(renderCard).join("\n")
}

export function renderChecklist(steps: RunbookStep[]) {
  const lines: string[] = []
  for (const step of steps) {
    lines.push(`- [ ] ${sectionLabel(step.section)} :: ${step.title} :: priority=${priorityLabel(step.priority)}`)
  }
  return lines.join("\n")
}
