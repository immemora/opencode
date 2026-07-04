import type { Order, OrderStatus } from "./report"

function statusLabel(status: OrderStatus) {
  if (status === "draft") return "Draft"
  if (status === "paid") return "Paid"
  if (status === "overdue") return "Overdue"
  if (status === "hold") return "On hold"
  if (status === "refunded") return "Refunded"
  return "Cancelled"
}

function money(totalCents: number) {
  return `$${(totalCents / 100).toFixed(2)}`
}

function overdueSuffix(order: Order) {
  if (order.status !== "overdue") return ""
  if (order.daysOverdue <= 0) return ""
  return ` overdue=${order.daysOverdue}d`
}

export function renderCompactLine(order: Order) {
  const parts = [
    order.id,
    order.customer,
    statusLabel(order.status),
    `${money(order.totalCents)}${overdueSuffix(order)}`,
  ]
  return parts.join(" | ")
}

export function renderConsoleReport(orders: Order[]) {
  const lines = ["orders", "------"]
  for (const order of orders) {
    lines.push(renderCompactLine(order))
  }
  return lines.join("\n")
}

export function renderAuditTrail(orders: Order[]) {
  return orders
    .map((order) => {
      const status = statusLabel(order.status)
      return `[${status}] ${order.id} ${order.customer}`
    })
    .join("\n")
}
