import type { Order, OrderStatus } from "./report"

function statusToken(status: OrderStatus) {
  if (status === "draft") return "Draft"
  if (status === "paid") return "Paid"
  if (status === "overdue") return "Overdue"
  if (status === "hold") return "Hold"
  if (status === "refunded") return "Refunded"
  return "Cancelled"
}

function money(totalCents: number) {
  return `$${(totalCents / 100).toFixed(2)}`
}

export function renderCompactLine(order: Order) {
  const parts = [
    order.id,
    order.customer,
    statusToken(order.status),
    money(order.totalCents),
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
      const status = statusToken(order.status)
      return `[${status}] ${order.id} ${order.customer}`
    })
    .join("\n")
}
