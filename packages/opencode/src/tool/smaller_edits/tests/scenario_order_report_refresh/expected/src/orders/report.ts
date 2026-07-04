export type OrderStatus = "draft" | "paid" | "overdue" | "hold" | "refunded" | "cancelled"

export type Order = {
  id: string
  customer: string
  status: OrderStatus
  totalCents: number
  daysOverdue: number
  tags: string[]
}

function money(totalCents: number) {
  return `$${(totalCents / 100).toFixed(2)}`
}

function statusLabel(status: OrderStatus) {
  if (status === "draft") return "Draft"
  if (status === "paid") return "Paid"
  if (status === "overdue") return "Overdue"
  if (status === "hold") return "On hold"
  if (status === "refunded") return "Refunded"
  return "Cancelled"
}

function agingLabel(daysOverdue: number) {
  if (daysOverdue <= 0) return "due now"
  if (daysOverdue === 1) return "1 day overdue"
  return `${daysOverdue} days overdue`
}

function renderTags(tags: string[]) {
  if (tags.length === 0) return "none"
  return tags.join(", ")
}

function renderDetailedStatus(order: Order) {
  const label = statusLabel(order.status)
  if (order.status !== "overdue") return label
  return `${label} (${agingLabel(order.daysOverdue)})`
}

function renderSummaryStatus(order: Order) {
  const label = statusLabel(order.status)
  if (order.status !== "overdue") return label
  return `${label} (${agingLabel(order.daysOverdue)})`
}

function renderOrderRow(order: Order) {
  return [
    `# ${order.id} ${order.customer}`,
    `  status: ${renderDetailedStatus(order)}`,
    `  total: ${money(order.totalCents)}`,
    `  tags: ${renderTags(order.tags)}`,
  ].join("\n")
}

export function renderDetailedReport(orders: Order[]) {
  const sections = ["Order report", "============", ""]
  for (const order of orders) {
    sections.push(renderOrderRow(order))
    sections.push("")
  }
  return sections.join("\n").trimEnd()
}

export function renderExpandedSummary(orders: Order[]) {
  const counts = {
    draft: orders.filter((order) => order.status === "draft").length,
    paid: orders.filter((order) => order.status === "paid").length,
    overdue: orders.filter((order) => order.status === "overdue").length,
    hold: orders.filter((order) => order.status === "hold").length,
    refunded: orders.filter((order) => order.status === "refunded").length,
    cancelled: orders.filter((order) => order.status === "cancelled").length,
  }

  const lines = [
    "Summary",
    "-------",
    `draft: ${counts.draft}`,
    `paid: ${counts.paid}`,
    `overdue: ${counts.overdue}`,
    `hold: ${counts.hold}`,
    `refunded: ${counts.refunded}`,
    `cancelled: ${counts.cancelled}`,
    "",
    "Expanded",
  ]

  for (const order of orders) {
    lines.push(`- ${order.id}: ${renderSummaryStatus(order)} for ${order.customer}`)
  }

  return lines.join("\n")
}

export const sampleOrders: Order[] = [
  {
    id: "ord_1001",
    customer: "Northwind Grocers",
    status: "draft",
    totalCents: 125000,
    daysOverdue: 0,
    tags: ["wholesale", "priority"],
  },
  {
    id: "ord_1002",
    customer: "Acorn Bakery",
    status: "overdue",
    totalCents: 48250,
    daysOverdue: 3,
    tags: ["retail"],
  },
  {
    id: "ord_1003",
    customer: "Summit Health",
    status: "paid",
    totalCents: 889900,
    daysOverdue: 0,
    tags: ["enterprise", "annual"],
  },
  {
    id: "ord_1004",
    customer: "Orbit Stationers",
    status: "hold",
    totalCents: 19900,
    daysOverdue: 0,
    tags: [],
  },
  {
    id: "ord_1005",
    customer: "Pine Catering",
    status: "refunded",
    totalCents: 31500,
    daysOverdue: 0,
    tags: ["credit-note"],
  },
  {
    id: "ord_1006",
    customer: "Bluebird Events",
    status: "cancelled",
    totalCents: 71200,
    daysOverdue: 0,
    tags: ["manual-review"],
  },
]
