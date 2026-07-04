import type { RunbookSection, RunbookStep } from "./outline"

function sectionTag(section: RunbookSection) {
  if (section === "prepare") return "Prepare"
  if (section === "verify") return "Verify"
  if (section === "rollback") return "Rollback"
  return "Followup"
}

export function renderCard(step: RunbookStep) {
  return `${step.title} :: ${sectionTag(step.section)} :: ${step.owner}`
}

export function renderDeck(steps: RunbookStep[]) {
  return steps.map(renderCard).join("\n")
}

export function renderChecklist(steps: RunbookStep[]) {
  const lines: string[] = []
  for (const step of steps) {
    lines.push(`- [ ] ${sectionTag(step.section)} :: ${step.title}`)
  }
  return lines.join("\n")
}
