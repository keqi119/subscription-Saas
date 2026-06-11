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

export const entitlementTypeLabels: Record<string, string> = {
  BENEFIT: "服务权益",
  ENERGY: "补能权益",
  MILEAGE: "里程权益"
};

export const entitlementUnitLabels: Record<string, string> = {
  ITEM: "项",
  KM: "公里",
  KWH: "kWh",
  TEXT: "文本权益",
  TIMES: "次"
};

export const entitlementGrantStatusLabels: Record<string, string> = {
  ACTIVE: "可用",
  CANCELLED: "已取消",
  EXHAUSTED: "已用尽",
  EXPIRED: "已过期"
};

export const entitlementUsageStatusLabels: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已确认"
};

export const entitlementUsageSourceLabels: Record<string, string> = {
  MANUAL: "人工录入",
  SYSTEM: "系统记录",
  THIRD_PARTY: "第三方接口"
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

export const vehicleAssetCostProfileStatusLabels: Record<string, string> = {
  ACTIVE: "生效中",
  INACTIVE: "已停用"
};

export const vehicleDepreciationMethodLabels: Record<string, string> = {
  MANUAL: "手工口径",
  NONE: "不计提",
  STRAIGHT_LINE: "直线法"
};

export const capitalCostSourceLabels: Record<string, string> = {
  COST_PROFILE: "成本参数",
  FINANCING_INSTRUMENT: "融资工具"
};

export const forecastResidualAmountSourceLabels: Record<string, string> = {
  ADOPTED: "人工采用",
  PREDICTED: "曲线预测"
};

export const residualForecastInterpolationMethodLabels: Record<string, string> = {
  EXACT: "精确匹配",
  LINEAR_INTERPOLATION: "线性插值",
  UNSUPPORTED_OUT_OF_RANGE: "超出曲线范围"
};

export const vehicleResidualCurveMethodLabels: Record<string, string> = {
  MANUAL: "手工曲线",
  ML_MODEL: "机器学习模型",
  STATISTICAL_MEDIAN: "统计中位数"
};

export const vehicleResidualCurveStatusLabels: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  SUPERSEDED: "已被替代"
};

export const vehicleResidualForecastMethodLabels: Record<string, string> = {
  CURVE_STATISTICAL: "统计曲线",
  MANUAL: "手工预测",
  ML_MODEL: "机器学习模型"
};

export const vehicleResidualForecastPointStatusLabels: Record<string, string> = {
  ADOPTED: "已采用",
  GENERATED: "已生成",
  UNSUPPORTED: "暂不支持"
};

export const vehicleResidualForecastStatusLabels: Record<string, string> = {
  ADOPTED: "已采用",
  ARCHIVED: "已归档",
  GENERATED: "已生成",
  VOIDED: "已作废"
};

export const financingInstrumentTypeLabels: Record<string, string> = {
  ABS_OR_SPV: "ABS / SPV 资产池融资",
  BANK_AUTO_LOAN: "银行车贷分期",
  BANK_PROJECT_LOAN: "银行项目贷款",
  FINANCE_LEASE: "融资租赁",
  OTHER: "其他",
  PERSONAL_LOAN: "个人借款",
  RECEIVABLE_PLEDGE: "应收账款权益质押融资"
};

export const financingAllocationStatusLabels: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  RELEASED: "已解除"
};

export const financingRepaymentMethodLabels: Record<string, string> = {
  BULLET: "到期还本付息",
  EQUAL_PRINCIPAL: "等额本金",
  EQUAL_PRINCIPAL_INTEREST: "等额本息",
  INTEREST_ONLY: "先息后本",
  MANUAL: "手工口径"
};

export const revenueRightAssignmentTypeLabels: Record<string, string> = {
  OTHER: "其他",
  PLEDGE: "收益权质押",
  REVENUE_SHARE: "收益分成",
  SPV_POOL: "SPV / 资产池归集",
  TRANSFER: "收益权转让"
};

export const revenueRightAssignmentStatusLabels: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  RELEASED: "已解除"
};

export const revenueRightTargetTypeLabels: Record<string, string> = {
  ORDER: "订单",
  RECEIVABLE_BILL: "应收账单",
  VEHICLE: "车辆",
  VEHICLE_POOL: "车辆池"
};

export const revenueRightAssigneeTypeLabels: Record<string, string> = {
  FINANCIER: "资方",
  LESSOR: "出租方",
  MANAGED_OWNER: "托管车主",
  OTHER: "其他",
  PLATFORM: "平台",
  SPV: "SPV / 资产池"
};

export const revenueShareRuleTypeLabels: Record<string, string> = {
  FIXED_RENT: "固定租金 / 固定成本",
  MIXED: "固定 + 分成",
  REVENUE_SHARE: "收益分成"
};

export const revenueShareBasisLabels: Record<string, string> = {
  GROSS_RECEIVABLE: "应收金额",
  MANUAL: "手工口径",
  OPERATING_REVENUE: "经营收入",
  RENTAL_PAID: "租金实收"
};

export const salePriceStatusLabels: Record<string, string> = {
  EFFECTIVE: "生效中",
  EXPIRED: "已过期",
  PENDING_INITIALIZE: "待初始化",
  REVIEW_DUE: "待复核"
};

export const vehicleSalePriceReviewTypeLabels: Record<string, string> = {
  INITIAL_POOL: "新入池初始化",
  MANUAL_ADJUST: "手工调整",
  QUARTERLY_REVIEW: "季度复核",
  RETURN_REINIT: "退车再入池重新定价"
};

export const vehicleDamageTypeLabels: Record<string, string> = {
  BATTERY: "电池",
  CHASSIS: "底盘",
  EQUIPMENT: "随车设备",
  EXTERIOR: "外观",
  GLASS: "玻璃",
  INTERIOR: "内饰",
  OTHER: "其他",
  TIRE: "轮胎"
};

export const vehicleDamageLevelLabels: Record<string, string> = {
  MEDIUM: "中等",
  MINOR: "轻微",
  SEVERE: "严重"
};

export const vehicleDamageResponsiblePartyLabels: Record<string, string> = {
  CUSTOMER: "客户",
  PLATFORM: "平台",
  THIRD_PARTY: "第三方",
  UNKNOWN: "未确认"
};

export const vehicleReturnDamageStatusLabels: Record<string, string> = {
  CONFIRMED: "已确认",
  RECORDED: "已记录",
  SETTLED: "已结算",
  WAIVED: "已豁免"
};

export const assetProfitabilityLifecycleNodeLabels: Record<string, string> = {
  DELIVERY: "交付",
  INITIAL_POOL: "首次入池",
  RETURN: "退车",
  RETURN_REINIT: "再入池",
  SALE_PRICE_REVIEW: "重新定价"
};

export function labelOf(labels: Record<string, string>, value: unknown) {
  return typeof value === "string" && value ? (labels[value] ?? value) : "-";
}
