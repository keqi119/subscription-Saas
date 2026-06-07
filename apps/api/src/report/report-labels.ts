export const orderStatusLabels: Record<string, string> = {
  ACTIVE: "在租",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
  PENDING_CONTRACT: "待生成合同",
  PENDING_CUSTOMER_CONFIRMATION: "待客户确认",
  PENDING_DELIVERY: "待交付",
  PENDING_PAYMENT: "待付款",
  PENDING_REVIEW: "待审核",
  PENDING_SIGN: "待签署",
  PENDING_VEHICLE: "待车辆确认",
  REJECTED: "已拒绝",
  SUSPENDED: "暂停履约",
  TERMINATED: "已终止"
};

export const orderSourceLabels: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自助",
  SALES_ASSISTED: "销售人工",
  SELF_SERVICE: "客户自助"
};

export const billTypeLabels: Record<string, string> = {
  DAMAGE_FEE: "损伤费用",
  DEPOSIT: "押金",
  FIRST_MONTHLY_FEE: "首期月费",
  MONTHLY_RENT: "月租账单",
  OTHER: "其他"
};

export const billStatusLabels: Record<string, string> = {
  CANCELLED: "已取消",
  OVERDUE: "已逾期",
  PAID: "已收款",
  PARTIALLY_PAID: "部分收款",
  PENDING: "待收款"
};

export const depositTransactionTypeLabels: Record<string, string> = {
  COLLECT: "收取",
  DEDUCT: "扣减",
  FREEZE: "冻结",
  REFUND: "退还",
  RELEASE: "释放"
};

export const depositTransactionStatusLabels: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已确认",
  PENDING: "待确认"
};

export const collectionLevelLabels: Record<string, string> = {
  D1: "D1：1-3天",
  D2: "D2：4-7天",
  D3: "D3：8-15天",
  D4: "D4：16-30天",
  D5: "D5：31天以上"
};

export const collectionCaseStatusLabels: Record<string, string> = {
  ACTIVE: "催收中",
  CLOSED: "已关闭",
  PAUSED: "暂停催收"
};

export const contractStatusLabels: Record<string, string> = {
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
  GENERATED: "已生成",
  SIGNED: "已签署",
  SIGNING: "签署中"
};

export const vehicleBatteryUsageTypeLabels: Record<string, string> = {
  BAAS: "BaaS",
  BUYOUT: "买断"
};

export const vehicleStatusLabels: Record<string, string> = {
  AVAILABLE: "可租用",
  DRAFT: "草稿",
  IN_PREPARATION: "整备中",
  LEASED: "已出租",
  MAINTENANCE: "维修中",
  RENTED: "已租赁",
  RESERVED: "签约锁定",
  RETIRED: "已退役",
  RETURNED: "已退回",
  REVIEW_RESERVED: "审核占用",
  SOLD: "已出售"
};

export function labelOf(labels: Record<string, string>, value: unknown) {
  return typeof value === "string" && value ? (labels[value] ?? value) : "-";
}
