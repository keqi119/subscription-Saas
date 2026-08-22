import type { MenuItemDefinition } from "@subscription-saas/shared";

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "系统管理员",
  AS: "资产运营",
  CS: "客服运营",
  FI: "财务专员",
  GM: "总经理 / 运营总监",
  OP: "运营管理",
  RC: "风控专员",
  SA: "销售顾问"
};

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "启用",
  APPROVED: "已通过",
  ARCHIVED: "已归档",
  AVAILABLE: "可用",
  BLACKLISTED: "黑名单",
  CANCELLED: "已取消",
  CONFIRMED: "已确认",
  COMPLETED: "已完成",
  DRAFT: "草稿",
  EFFECTIVE: "生效中",
  EXECUTED: "已完成退回处理",
  EXPIRED: "已过期",
  FROZEN: "冻结",
  GENERATED: "已生成",
  IN_PREPARATION: "整备中",
  INACTIVE: "停用",
  LEAD: "线索",
  LEASED: "已出租",
  MAINTENANCE: "维修 / 整备",
  NEED_MORE_INFO: "待补件",
  PENDING: "待审核",
  PENDING_APPLICATION: "待进件",
  PENDING_CONFIRM: "待确认",
  PENDING_CONTRACT: "待生成合同",
  PENDING_CUSTOMER_CONFIRMATION: "待客户确认",
  PENDING_DELIVERY: "待交付",
  PENDING_INITIALIZE: "待初始化",
  PENDING_PAYMENT: "待付款",
  PENDING_RETURN: "待退车",
  PENDING_REVIEW: "待订单审核",
  PENDING_SIGN: "待签署",
  PENDING_VEHICLE: "待分车",
  REJECTED: "已拒绝",
  RENTED: "已租赁",
  RESERVED: "签约锁定（待交付）",
  RETIRED: "已退役",
  RETURNED: "已退回",
  RETURN_DUE: "到期待退车",
  REVIEW_RESERVED: "审核占用",
  REVIEW_DUE: "待复核",
  SIGNED: "已签署",
  SIGNING: "签署中",
  SUBMITTED: "已提交",
  SUSPENDED: "暂停",
  TERMINATED: "已终止",
  UNDER_REVIEW: "审批中"
};

export const PAYMENT_MANDATE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "已生效",
  EXPIRED: "已过期",
  FAILED: "授权失败",
  PENDING: "待确认",
  REVOKED: "已解约",
  SUSPENDED: "已暂停"
};

export const DEBIT_ATTEMPT_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CREATED: "待提交",
  FAILED_FINAL: "最终失败",
  FAILED_RETRYABLE: "待重试",
  PROCESSING: "处理中",
  SUBMITTING: "提交中",
  SUCCEEDED: "已成功",
  UNKNOWN: "结果不明"
};

export const CUSTOMER_ACCOUNT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "正常",
  DISABLED: "已禁用"
};

export const CUSTOMER_VERIFICATION_CODE_PURPOSE_LABELS: Record<string, string> = {
  BIND_PHONE: "绑定手机号",
  LOGIN: "登录"
};

export const SERVICE_CASE_TYPE_LABELS: Record<string, string> = {
  ACCIDENT_REPORT: "事故报案",
  CUSTOMER_SUPPORT: "客户服务",
  RESCUE_REQUEST: "救援申请"
};

export const SERVICE_CASE_STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "已受理",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  IN_PROGRESS: "处理中",
  RESOLVED: "已解决",
  SUBMITTED: "已提交",
  WAITING_CUSTOMER: "待客户补充"
};

export const SERVICE_CASE_PRIORITY_LABELS: Record<string, string> = {
  HIGH: "高",
  LOW: "低",
  NORMAL: "普通",
  URGENT: "紧急"
};

export const RESCUE_TYPE_LABELS: Record<string, string> = {
  ACCIDENT_RESCUE: "事故救援",
  JUMP_START: "搭电",
  OTHER: "其他",
  TIRE_CHANGE: "换胎",
  TOWING: "拖车"
};

export const SERVICE_CASE_ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  DOCUMENT: "文件",
  IMAGE: "图片",
  OTHER: "其他"
};

export const SERVICE_CASE_ACTION_TYPE_LABELS: Record<string, string> = {
  ACCEPT: "受理",
  ADD_NOTE: "处理记录",
  CANCEL: "取消",
  CLOSE: "关闭",
  RESOLVE: "解决",
  SUBMIT: "提交",
  UPDATE_STATUS: "更新状态",
  UPLOAD_ATTACHMENT: "上传附件"
};

export const SERVICE_CASE_ACTOR_TYPE_LABELS: Record<string, string> = {
  CUSTOMER: "客户",
  STAFF: "员工",
  SYSTEM: "系统"
};

export const NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "邮件",
  IN_APP: "站内消息",
  SMS: "短信",
  WECHAT_OFFICIAL_ACCOUNT: "微信服务号"
};

export const NOTIFICATION_TEMPLATE_TYPE_LABELS: Record<string, string> = {
  APPLICATION_PROGRESS: "申请进度",
  BILL_DUE: "账单到期",
  BILL_OVERDUE: "账单逾期",
  CONTRACT_PENDING: "待签约",
  FINAL_PLAN_PENDING: "最终方案待确认",
  MATERIAL_REQUIRED: "待补件",
  PAYMENT_PENDING: "待支付",
  RENEWAL_EXPIRY_RETURN: "到期退车",
  RENEWAL_REMINDER: "续订提醒",
  RENEWAL_RETURN_OVERDUE: "逾期未退车",
  RESCUE_UPDATE: "救援进度",
  SERVICE_CASE_UPDATE: "服务工单进度",
  SYSTEM: "系统通知"
};

export const NOTIFICATION_TEMPLATE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "启用",
  INACTIVE: "停用"
};

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  APPLICATION_PROGRESS: "申请进度",
  BILL_DUE: "账单到期",
  BILL_OVERDUE: "账单逾期",
  CONTRACT_PENDING: "待签约",
  FINAL_PLAN_PENDING: "最终方案待确认",
  MATERIAL_REQUIRED: "待补件",
  PAYMENT_PENDING: "待支付",
  RENEWAL_EXPIRY_RETURN: "到期退车",
  RENEWAL_REMINDER: "续订提醒",
  RENEWAL_RETURN_OVERDUE: "逾期未退车",
  RESCUE_UPDATE: "救援进度",
  SERVICE_CASE_UPDATE: "服务工单进度",
  SYSTEM: "系统通知"
};

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  FAILED: "发送失败",
  PENDING: "待发送",
  READ: "已读",
  SENT: "已发送",
  SKIPPED: "已跳过"
};

export const NOTIFICATION_EVENT_TYPE_LABELS: Record<string, string> = {
  APPLICATION_SUBMITTED: "申请已提交",
  BILL_DUE: "账单到期",
  BILL_OVERDUE: "账单逾期",
  CONTRACT_PENDING: "合同待签署",
  FINAL_PLAN_READY: "最终方案待确认",
  MATERIAL_REQUIRED: "待补件",
  PAYMENT_PENDING: "待支付",
  RESCUE_UPDATED: "救援进度更新",
  SERVICE_CASE_SUBMITTED: "服务工单已提交",
  SERVICE_CASE_UPDATED: "服务工单更新"
};

export const NOTIFICATION_EVENT_STATUS_LABELS: Record<string, string> = {
  FAILED: "处理失败",
  PENDING: "待处理",
  PROCESSED: "已处理",
  PROCESSING: "处理中",
  SKIPPED: "已跳过"
};

export const VEHICLE_STATUS_LABELS: Record<string, string> = {
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

export const VEHICLE_MODEL_LABELS: Record<string, string> = {
  EC6: "EC6",
  ES6: "ES6",
  ES8: "ES8",
  ES9: "ES9",
  ET5: "ET5",
  ET5T: "ET5T",
  ET7: "ET7",
  ET9: "ET9"
};

export const VEHICLE_LISTING_STATUS_LABELS: Record<string, string> = {
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  UNPUBLISHED: "已下架"
};

export const VEHICLE_LISTING_CONDITION_GRADE_LABELS: Record<string, string> = {
  A: "优秀",
  B: "良好",
  C: "一般",
  D: "需整备",
  S: "准新 / 极佳",
  UNKNOWN: "待确认"
};

export const VEHICLE_LISTING_MEDIA_CATEGORY_LABELS: Record<string, string> = {
  BATTERY: "电池",
  CENTRAL_CONTROL: "中控",
  CHARGING_PORT: "充电口",
  COVER: "封面",
  DASHBOARD: "仪表",
  DEFECT: "瑕疵",
  EXTERIOR: "外观",
  INSPECTION_REPORT: "检测报告",
  INTERIOR: "内饰",
  OTHER: "其他",
  TIRE: "轮胎"
};

export const VEHICLE_CONDITION_REPORT_STATUS_LABELS: Record<string, string> = {
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  PUBLISHED: "已发布"
};

export const VEHICLE_CONDITION_ITEM_AREA_LABELS: Record<string, string> = {
  BATTERY: "电池",
  BRAKE: "制动",
  CHARGING: "充电系统",
  CHASSIS: "底盘",
  ELECTRONICS: "电子设备",
  EXTERIOR: "外观",
  GLASS_LIGHT: "玻璃灯光",
  INTERIOR: "内饰",
  OTHER: "其他",
  TIRE: "轮胎"
};

export const VEHICLE_CONDITION_ITEM_TYPE_LABELS: Record<string, string> = {
  BATTERY_CHECK: "电池检测",
  CHECK: "常规检测",
  DEFECT: "瑕疵",
  OTHER: "其他",
  REPAIR_RECOMMENDATION: "整备建议",
  SAFETY_CHECK: "安全检测"
};

export const VEHICLE_CONDITION_ITEM_SEVERITY_LABELS: Record<string, string> = {
  MAJOR: "明显",
  MINOR: "轻微",
  MODERATE: "一般",
  SAFETY_CRITICAL: "影响安全"
};

export const VEHICLE_CONDITION_ITEM_RESULT_LABELS: Record<string, string> = {
  ABNORMAL: "异常",
  ATTENTION: "需关注",
  NORMAL: "正常",
  REPAIRED: "已修复",
  UNKNOWN: "待确认"
};

export const CUSTOMER_PROFILE_MATERIAL_TYPE_LABELS: Record<string, string> = {
  DRIVER_LICENSE_BACK: "驾驶证副页",
  DRIVER_LICENSE_FRONT: "驾驶证主页",
  ID_CARD_BACK: "身份证国徽面",
  ID_CARD_FRONT: "身份证人像面",
  OTHER: "其他资料"
};

export const CUSTOMER_PROFILE_MATERIAL_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "当前有效",
  ARCHIVED: "已归档",
  REPLACED: "已替换"
};

export const VEHICLE_INSURANCE_POLICY_TYPE_LABELS: Record<string, string> = {
  COMMERCIAL: "商业险",
  COMPULSORY_TRAFFIC: "交强险",
  OTHER: "其他"
};

export const VEHICLE_INSURANCE_POLICY_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
  EXPIRED: "已过期",
  NOT_EFFECTIVE: "未生效",
  PENDING_RENEWAL: "待续保"
};

export const VEHICLE_INSURANCE_COVERAGE_TYPE_LABELS: Record<string, string> = {
  ADDITIONAL: "附加险",
  COMPULSORY_TRAFFIC: "交强险",
  MEDICAL_OUTSIDE: "医保外用药",
  OTHER: "其他",
  THIRD_PARTY_LIABILITY: "第三者责任险",
  VEHICLE_DAMAGE: "车辆损失险",
  VEHICLE_PERSONNEL: "车上人员险"
};

export const VEHICLE_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  COMMERCIAL_INSURANCE_POLICY: "商业险保单",
  COMPULSORY_INSURANCE_POLICY: "交强险保单",
  INSPECTION_CERTIFICATE: "年检材料",
  MOTOR_VEHICLE_INVOICE: "机动车发票",
  OTHER: "其他车辆材料",
  OWNER_IDENTITY_DOCUMENT: "车主信息",
  PURCHASE_PAYMENT_VOUCHER: "车辆采购支付凭证",
  VEHICLE_AUTHORIZATION: "车辆授权文件",
  VEHICLE_CONFIGURATION_SHEET: "车辆配置单",
  VEHICLE_INSPECTION_REPORT: "车辆检测报告",
  VEHICLE_LICENSE: "行驶证",
  VEHICLE_PURCHASE_AGREEMENT: "车辆购买合同及附属协议",
  VEHICLE_REGISTRATION_CERTIFICATE: "机动车登记证"
};

export const VEHICLE_DOCUMENT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "当前有效",
  ARCHIVED: "已归档"
};

export const INSURANCE_CLAIM_STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "已受理",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  DRAFT: "草稿",
  IN_PROGRESS: "处理中",
  REJECTED: "已拒赔",
  SETTLED: "已结算",
  SUBMITTED: "已提交"
};

export const VEHICLE_BAAS_CONTRACT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  EXPIRED: "已过期",
  SUSPENDED: "已暂停",
  TERMINATED: "已终止"
};

export const VEHICLE_BAAS_BILLING_CYCLE_LABELS: Record<string, string> = {
  MONTHLY: "月付",
  QUARTERLY: "季付",
  YEARLY: "年付"
};

export const VEHICLE_BAAS_CONTRACT_ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  CONTRACT: "合同附件",
  INVOICE: "发票",
  OTHER: "其他"
};

export const VEHICLE_BAAS_COST_RECORD_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  OVERDUE: "已逾期",
  PAID: "已支付",
  SCHEDULED: "待处理",
  VOIDED: "已作废",
  WAIVED: "已减免"
};

export const VEHICLE_BAAS_COST_SOURCE_LABELS: Record<string, string> = {
  GENERATED: "系统生成",
  IMPORTED: "导入",
  MANUAL: "手工"
};

export const VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  INACTIVE: "已停用"
};

export const VEHICLE_ACQUISITION_MODE_LABELS: Record<string, string> = {
  LONG_TERM_LEASED: "外部长租取得",
  MANAGED_REVENUE_SHARE: "托管收益分成取得",
  OWNED_CASH: "自有资金购入",
  OWNED_FINANCED: "自有资金 + 外部融资购入"
};

export const VEHICLE_CAPITAL_EVENT_TYPE_LABELS: Record<string, string> = {
  ADD_DEBT_FINANCING: "新增债务融资",
  EARLY_SETTLEMENT: "提前结清",
  FINANCING_RELEASE: "融资解除",
  INITIAL_EQUITY_PURCHASE: "初始自有资金购入",
  LEASE_IN: "外部长租接入",
  LEASE_TERMINATION: "外部长租终止",
  MANAGED_IN: "托管车辆接入",
  MANAGED_TERMINATION: "托管终止",
  OTHER: "其他",
  REFINANCE: "再融资"
};

export const VEHICLE_CAPITAL_EVENT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  ENDED: "已结束"
};

export const FINANCING_INSTRUMENT_TYPE_LABELS: Record<string, string> = {
  ABS_OR_SPV: "ABS / SPV 资产池融资",
  BANK_AUTO_LOAN: "银行车贷分期",
  BANK_PROJECT_LOAN: "银行项目贷款",
  FINANCE_LEASE: "融资租赁",
  OTHER: "其他",
  PERSONAL_LOAN: "个人借款",
  RECEIVABLE_PLEDGE: "应收账款权益质押融资"
};

export const FINANCING_INSTRUMENT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  SETTLED: "已结清"
};

export const FINANCING_REPAYMENT_METHOD_LABELS: Record<string, string> = {
  BULLET: "到期还本付息",
  EQUAL_PRINCIPAL: "等额本金",
  EQUAL_PRINCIPAL_INTEREST: "等额本息",
  INTEREST_ONLY: "先息后本",
  MANUAL: "手工口径"
};

export const FINANCING_COLLATERAL_TYPE_LABELS: Record<string, string> = {
  BILL_RECEIVABLE: "账单应收",
  MIXED: "混合担保",
  NONE: "无担保",
  ORDER_RECEIVABLE: "订单应收",
  OTHER: "其他",
  VEHICLE: "单车抵押 / 融资",
  VEHICLE_POOL: "车辆池"
};

export const FINANCING_ALLOCATION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  RELEASED: "已解除"
};

export const VEHICLE_ASSET_POOL_TYPE_LABELS: Record<string, string> = {
  ASSET_MANAGEMENT: "资产管理车辆池",
  FINANCING: "融资车辆池",
  OPERATION: "运营车辆池",
  OTHER: "其他",
  REPORTING: "报表统计车辆池"
};

export const VEHICLE_ASSET_POOL_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  INACTIVE: "已停用"
};

export const VEHICLE_ASSET_POOL_VEHICLE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  REMOVED: "已移出"
};

export const VEHICLE_POOL_ALLOCATION_METHOD_LABELS: Record<string, string> = {
  EQUAL_AMOUNT: "等额分摊",
  MANUAL_AMOUNT: "手工金额",
  UNIFORM_CURRENT_SALE_PRICE_COVERAGE: "按当前销售价统一覆盖率",
  UNIFORM_PURCHASE_PRICE_COVERAGE: "按车辆采购价统一覆盖率"
};

export const VEHICLE_POOL_ALLOCATION_ACTION_LABELS: Record<string, string> = {
  CREATE: "将创建",
  FAILED: "失败",
  SKIP: "跳过"
};

export const CAPITAL_COST_SOURCE_LABELS: Record<string, string> = {
  COST_PROFILE: "成本参数",
  FINANCING_INSTRUMENT: "融资工具"
};

export const REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS: Record<string, string> = {
  OTHER: "其他",
  PLEDGE: "收益权质押",
  REVENUE_SHARE: "收益分成",
  SPV_POOL: "SPV / 资产池归集",
  TRANSFER: "收益权转让"
};

export const REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  RELEASED: "已解除"
};

export const REVENUE_RIGHT_TARGET_TYPE_LABELS: Record<string, string> = {
  ORDER: "订单",
  RECEIVABLE_BILL: "应收账单",
  VEHICLE: "车辆",
  VEHICLE_POOL: "车辆池"
};

export const REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS: Record<string, string> = {
  FINANCIER: "资方",
  LESSOR: "出租方",
  MANAGED_OWNER: "托管车主",
  OTHER: "其他",
  PLATFORM: "平台",
  SPV: "SPV / 资产池"
};

export const REVENUE_SHARE_RULE_TYPE_LABELS: Record<string, string> = {
  FIXED_RENT: "固定租金 / 固定成本",
  MIXED: "固定 + 分成",
  REVENUE_SHARE: "收益分成"
};

export const REVENUE_SHARE_RULE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CANCELLED: "已取消",
  INACTIVE: "已停用"
};

export const REVENUE_SHARE_BASIS_LABELS: Record<string, string> = {
  GROSS_RECEIVABLE: "应收金额",
  MANUAL: "手工口径",
  OPERATING_REVENUE: "经营收入",
  RENTAL_PAID: "租金实收"
};

export const REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS: Record<string, string> = {
  MANUAL: "手工结算",
  MONTHLY: "月结",
  ON_RETURN: "退车结算",
  QUARTERLY: "季结"
};

export const VEHICLE_DEPRECIATION_METHOD_LABELS: Record<string, string> = {
  MANUAL: "手工口径",
  NONE: "不计提",
  STRAIGHT_LINE: "直线法"
};

export const VEHICLE_DEPRECIATION_SOURCE_LABELS: Record<string, string> = {
  LEGACY_COST_PROFILE: "旧成本参数",
  NONE: "无折旧",
  RECORDS: "折旧记录",
  UNAVAILABLE: "不可用"
};

export const VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效",
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  SUSPENDED: "已暂停",
  TERMINATED: "已终止"
};

export const VEHICLE_DEPRECIATION_BASIS_SOURCE_LABELS: Record<string, string> = {
  ASSET_COST_PROFILE: "成本参数",
  MANUAL: "手工录入",
  OTHER: "其他",
  PURCHASE_COST: "采购成本"
};

export const VEHICLE_DEPRECIATION_SCHEDULE_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  LOCKED: "已锁定",
  SCHEDULED: "待确认",
  VOIDED: "已作废"
};

export const VEHICLE_DEPRECIATION_RECORD_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  DRAFT: "草稿",
  LOCKED: "已锁定",
  VOIDED: "已作废"
};

export const VEHICLE_DEPRECIATION_RECORD_SOURCE_LABELS: Record<string, string> = {
  ADJUSTMENT: "调整",
  IMPORTED: "导入",
  MANUAL: "手工补录",
  SCHEDULED: "计划确认"
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "在租",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
  PENDING_CONTRACT: "待生成合同",
  PENDING_CUSTOMER_CONFIRMATION: "待客户确认",
  PENDING_DELIVERY: "待交付",
  PENDING_PAYMENT: "待付款",
  PENDING_RETURN: "待退车",
  PENDING_REVIEW: "待审核",
  PENDING_SIGN: "待签署",
  PENDING_VEHICLE: "待车辆确认",
  REJECTED: "已拒绝",
  SUSPENDED: "暂停履约",
  TERMINATED: "已终止"
};

export const SUBSCRIPTION_CHANGE_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  COMPLETED: "已完成",
  CUSTOMER_CONFIRMED: "客户已确认报价",
  DRAFT: "草稿",
  EXECUTING: "生效处理中",
  FAILED: "处理失败",
  MANUAL_TAKEOVER: "人工接管",
  QUOTED: "已正式报价",
  SCHEDULED: "已签约待生效",
  SIGNING_OR_PAYMENT: "签约处理中"
};

export const SUBSCRIPTION_CHANGE_PRICING_MODE_LABELS: Record<string, string> = {
  APPROVED_DISCOUNT: "已审批折扣",
  CURRENT_VERSION: "当前版本价格",
  ORIGINAL_PRICE: "原合同价格"
};

export const SUBSCRIPTION_CHANGE_QUOTE_STATUS_LABELS: Record<string, string> = {
  CUSTOMER_CONFIRMED: "客户已确认",
  CUSTOMER_REJECTED: "客户已拒绝",
  DRAFT: "草稿",
  EXPIRED: "已过期",
  FORMAL: "正式报价",
  SUPERSEDED: "已被新版本替代"
};

export const CONTRACT_SEGMENT_TYPE_LABELS: Record<string, string> = {
  BASE: "原合同",
  EXTENSION: "续期补充协议"
};

export const CONTRACT_SEGMENT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "履约中",
  CANCELLED: "已取消",
  COMPLETED: "已履约完成",
  SCHEDULED: "待生效"
};

export const RENEWAL_CONSIDERATION_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  EXPIRED: "已到期",
  EXPIRY_CONFIRMED: "客户选择到期结束",
  EXTENDED: "续订已完成",
  EXTENSION_IN_PROGRESS: "续订办理中",
  PENDING_DECISION: "待客户决定",
  RENEWAL_REQUESTED: "客户已申请续订"
};

export const RENEWAL_REMINDER_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  FAILED: "发送失败",
  PENDING: "待发送",
  SENT: "已发送",
  SKIPPED_DECIDED: "客户已决定，已跳过",
  SKIPPED_EXTENDED: "续订已完成，已跳过",
  SKIPPED_LATE_ENROLLMENT: "进入考虑期过晚，已跳过"
};

export const CONTRACT_TEMPLATE_TYPE_LABELS: Record<string, string> = {
  DELIVERY_HANDOVER: "车辆交接确认单",
  SUBSCRIPTION_EXTENSION: "订阅续期补充协议",
  SUBSCRIPTION_STANDARD: "标准订阅合同"
};

export const APPLICATION_SOURCE_LABELS: Record<string, string> = {
  SALES_ASSISTED: "销售人工",
  SELF_SERVICE: "客户自助"
};

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  APPROVED: "已通过",
  NEED_MORE_INFO: "需补充资料",
  PENDING: "待审核",
  REJECTED: "已拒绝"
};

export const DEPOSIT_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "押金已确认",
  PENDING_CONFIRM: "押金待确认",
  REJECTED: "押金拒绝",
  WAIVED: "押金减免"
};

export const BILL_TYPE_LABELS: Record<string, string> = {
  DAMAGE_FEE: "损伤费用",
  DEPOSIT: "押金",
  FIRST_MONTHLY_FEE: "首期月费",
  MONTHLY_RENT: "月租账单",
  OTHER: "其他"
};

export const BILL_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  OVERDUE: "已逾期",
  PAID: "已收款",
  PARTIALLY_PAID: "部分收款",
  PENDING: "待收款"
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ALIPAY: "支付宝",
  BANK_TRANSFER: "银行转账",
  CASH: "现金",
  OTHER: "其他",
  WECHAT: "微信"
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已确认",
  PENDING_CONFIRM: "待确认"
};

export const PAYMENT_ORDER_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  CREATED: "已创建",
  EXPIRED: "已过期",
  FAILED: "支付失败",
  PAID: "已支付",
  PENDING: "待支付"
};

export const PAYMENT_CHANNEL_LABELS: Record<string, string> = {
  ALIPAY_H5: "支付宝 H5",
  BANK_TRANSFER: "银行转账",
  MOCK: "模拟支付",
  WECHAT_H5: "微信 H5",
  WECHAT_JSAPI: "微信 JSAPI"
};

export const PAYMENT_PROVIDER_LABELS: Record<string, string> = {
  ALIPAY: "支付宝",
  BANK_TRANSFER: "银行转账",
  MOCK: "Mock 支付",
  OTHER: "其他",
  WECHAT_PAY: "微信支付"
};

export const DEPOSIT_TRANSACTION_TYPE_LABELS: Record<string, string> = {
  COLLECT: "收取",
  DEDUCT: "扣减",
  FREEZE: "冻结",
  REFUND: "退还",
  RELEASE: "释放"
};

export const DEPOSIT_TRANSACTION_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已确认",
  PENDING: "待确认"
};

export const ENTITLEMENT_ACCOUNT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  CLOSED: "已关闭",
  SUSPENDED: "暂停"
};

export const ENTITLEMENT_TYPE_LABELS: Record<string, string> = {
  BENEFIT: "服务权益",
  ENERGY: "补能权益",
  MILEAGE: "里程权益"
};

export const ENTITLEMENT_UNIT_LABELS: Record<string, string> = {
  ITEM: "项",
  KM: "公里",
  KWH: "kWh",
  TEXT: "文本权益",
  TIMES: "次"
};

export const ENTITLEMENT_GRANT_SOURCE_LABELS: Record<string, string> = {
  MANUAL_ADJUST: "手工调整",
  MONTHLY_RENEWAL: "月度续发",
  ORDER_START: "起租发放"
};

export const ENTITLEMENT_GRANT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "可用",
  CANCELLED: "已取消",
  EXHAUSTED: "已用尽",
  EXPIRED: "已过期"
};

export const ENTITLEMENT_USAGE_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已确认"
};

export const ENTITLEMENT_USAGE_SOURCE_LABELS: Record<string, string> = {
  MANUAL: "人工录入",
  SYSTEM: "系统记录",
  THIRD_PARTY: "第三方接口"
};

export const COLLECTION_LEVEL_LABELS: Record<string, string> = {
  D1: "D1：1-3天",
  D2: "D2：4-7天",
  D3: "D3：8-15天",
  D4: "D4：16-30天",
  D5: "D5：31天以上"
};

export const COLLECTION_CASE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "催收中",
  CLOSED: "已关闭",
  PAUSED: "暂停催收"
};

export const COLLECTION_ACTION_TYPE_LABELS: Record<string, string> = {
  CLOSE: "关闭",
  CUSTOMER_DISPUTE: "客户异议",
  ESCALATION: "升级处理",
  FOLLOW_UP: "跟进",
  PROMISE_TO_PAY: "承诺付款",
  REMINDER: "提醒"
};

export const CONTACT_METHOD_LABELS: Record<string, string> = {
  EMAIL: "邮件",
  OFFLINE: "线下",
  OTHER: "其他",
  PHONE: "电话",
  SMS: "短信",
  SYSTEM: "系统",
  WECHAT: "微信"
};

export const COLLECTION_ACTION_RESULT_LABELS: Record<string, string> = {
  CUSTOMER_PROMISED: "承诺付款",
  CUSTOMER_REFUSED: "拒绝付款",
  DISPUTED: "有异议",
  INVALID_CONTACT: "联系方式无效",
  NO_ANSWER: "未接通",
  OTHER: "其他",
  SUCCESS: "已触达"
};

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  DELIVERED: "已交付",
  PENDING: "待准备",
  READY: "待交付"
};

export const VEHICLE_RETURN_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  CONFIRMED: "已退车",
  PENDING: "待退车",
  READY: "待验收"
};

export const VEHICLE_RETURN_TYPE_LABELS: Record<string, string> = {
  EARLY_TERMINATION: "提前终止退车",
  NORMAL_RETURN: "正常到期退车"
};

export const VEHICLE_DAMAGE_TYPE_LABELS: Record<string, string> = {
  BATTERY: "电池",
  CHASSIS: "底盘",
  EQUIPMENT: "随车设备",
  EXTERIOR: "外观",
  GLASS: "玻璃",
  INTERIOR: "内饰",
  OTHER: "其他",
  TIRE: "轮胎"
};

export const VEHICLE_DAMAGE_LEVEL_LABELS: Record<string, string> = {
  MEDIUM: "中等",
  MINOR: "轻微",
  SEVERE: "严重"
};

export const VEHICLE_DAMAGE_RESPONSIBLE_PARTY_LABELS: Record<string, string> = {
  CUSTOMER: "客户",
  PLATFORM: "平台",
  THIRD_PARTY: "第三方",
  UNKNOWN: "未确认"
};

export const VEHICLE_RETURN_DAMAGE_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  RECORDED: "已记录",
  SETTLED: "已结算",
  WAIVED: "已豁免"
};

export const PLAN_CONFIRM_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  PENDING: "待确认",
  REJECTED: "已拒绝"
};

export const PORTAL_PROGRESS_STEP_LABELS: Record<string, string> = {
  ACTIVE: "在租中",
  CANCELLED: "已取消",
  CONTRACT: "待签约",
  CREDIT_REVIEW: "信用审核",
  DELIVERY: "待交付",
  DEPOSIT_CONFIRM: "押金确认",
  FINAL_PLAN: "最终方案确认",
  MATERIAL_REVIEW: "材料审核",
  ORDER: "生成正式订单",
  PAYMENT: "待支付",
  PRODUCT_REVIEW: "产品方案审核",
  REJECTED: "已拒绝",
  SUBMITTED: "已提交",
  VEHICLE_REVIEW: "车辆库存审核"
};

export const PORTAL_NEXT_ACTION_LABELS: Record<string, string> = {
  CANCELLED: "申请已取消",
  CONFIRM_FINAL_PLAN: "请确认最终方案",
  GO_CONTRACT: "等待合同签署",
  GO_CONTRACT_PENDING_BACKOFFICE: "已确认最终方案，等待平台生成正式订单",
  GO_PAYMENT: "等待支付",
  NONE: "无后续操作",
  REJECTED: "方案或申请已拒绝",
  SUBMIT_MILEAGE_REVIEW: "请提交本月里程",
  UPLOAD_MATERIAL: "请补充材料",
  WAIT_DELIVERY: "等待交付",
  WAIT_ORDER_CREATION: "已确认最终方案，等待平台生成正式订单",
  WAIT_REVIEW: "等待平台审核"
};

export const PORTAL_PROGRESS_STATUS_LABELS: Record<string, string> = {
  CURRENT: "进行中",
  DONE: "已完成",
  FAILED: "未通过",
  PENDING: "待处理"
};

export const PORTAL_FINAL_PLAN_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "已确认",
  NOT_READY: "暂未生成",
  PENDING_CONFIRM: "待确认",
  REJECTED: "已拒绝"
};

export const ESIGN_TASK_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  COMPLETED: "已签署",
  CREATED: "已创建",
  EXPIRED: "已过期",
  FAILED: "签署失败",
  SIGNING: "签署中",
  WAITING_CUSTOMER: "待客户签署"
};

export const ESIGN_SIGNER_STATUS_LABELS: Record<string, string> = {
  EXPIRED: "已过期",
  PENDING: "待签署",
  REJECTED: "已拒签",
  SIGNED: "已签署",
  SIGNING: "签署中"
};

export const ESIGN_PROVIDER_LABELS: Record<string, string> = {
  ESIGN: "e签宝",
  FADADA: "法大大",
  MOCK: "Mock 电子签",
  OTHER: "其他",
  TENCENT_ESIGN: "腾讯电子签"
};

export const MATERIAL_STATUS_LABELS: Record<string, string> = {
  APPROVED: "已通过",
  NEED_MORE_INFO: "需补充资料",
  PENDING: "待审核",
  REJECTED: "不通过",
  VERIFIED: "已通过"
};

export const MATERIAL_TYPE_LABELS: Record<string, string> = {
  BANK_FLOW: "银行流水",
  CREDIT_AUTH: "征信授权",
  DRIVER_LICENSE: "驾驶证",
  ID_CARD: "身份证",
  OTHER: "其他",
  RESIDENCE_PROOF: "居住证明",
  WORK_PROOF: "工作证明"
};

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  RENT_TO_OWN: "以租代购（暂未开放）",
  SUBSCRIPTION: "订阅产品"
};

export const BENEFIT_TYPE_LABELS: Record<string, string> = {
  CAR_SWAP: "换车权益",
  DRIVER_SERVICE: "代驾权益",
  OTHER: "其他权益",
  POINTS: "积分权益",
  WASH_CAR: "洗车权益"
};

export const PRODUCT_VERSION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  APPROVED: "已审批",
  DRAFT: "草稿",
  INACTIVE: "已停用"
};

export const SALE_PRICE_REVIEW_TYPE_LABELS: Record<string, string> = {
  INITIAL_POOL: "新入池初始化",
  MANUAL_ADJUST: "手工调整",
  QUARTERLY_REVIEW: "季度复核",
  RESIDUAL_FORECAST_ADOPTION: "残值预测采用复核",
  RETURN_REINIT: "退车再入池重新定价"
};

export const VEHICLE_VALUATION_REVIEW_SOURCE_LABELS: Record<string, string> = {
  MANUAL: "手工发起",
  OTHER: "其他",
  QUARTERLY_REVIEW: "季度复核",
  RESIDUAL_FORECAST: "残值预测",
  RETURN_REINIT: "退车再入池"
};

export const VEHICLE_VALUATION_REVIEW_STATUS_LABELS: Record<string, string> = {
  APPROVED: "已通过",
  CANCELLED: "已取消",
  PENDING: "待审核",
  REJECTED: "已拒绝"
};

export const VEHICLE_BASE_FEE_MODE_LABELS: Record<string, string> = {
  FIXED_AMOUNT: "固定金额",
  MANUAL_QUOTE: "现场报价",
  RATE_FORMULA: "固定费率"
};

export const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<string, string> = {
  BAAS: "BaaS",
  BUYOUT: "买断"
};

export const MARKET_PRICE_SOURCE_LABELS: Record<string, string> = {
  AUCTION: "拍卖",
  CSV_IMPORT: "CSV 导入",
  DEALER_QUOTE: "经销商报价",
  INTERNAL_DISPOSAL: "内部处置成交",
  MANUAL: "手工录入",
  OTHER: "其他",
  USED_CAR_PLATFORM: "二手车平台"
};

export const MARKET_PRICE_TYPE_LABELS: Record<string, string> = {
  AUCTION: "拍卖价",
  DEALER_QUOTE: "经销商报价",
  ESTIMATE: "估算价",
  INTERNAL_SALE: "内部成交价",
  LISTING: "挂牌价",
  TRANSACTION: "成交价"
};

export const MARKET_SELLER_TYPE_LABELS: Record<string, string> = {
  AUCTION_HOUSE: "拍卖机构",
  DEALER: "经销商",
  INDIVIDUAL: "个人",
  INTERNAL: "内部",
  PLATFORM: "平台",
  UNKNOWN: "未知"
};

export const MARKET_PRICE_OBSERVATION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "有效",
  IGNORED: "已忽略",
  VOIDED: "已作废"
};

export const MARKET_PRICE_IMPORT_STATUS_LABELS: Record<string, string> = {
  COMPLETED: "已完成",
  FAILED: "失败",
  PARTIAL_FAILED: "部分失败"
};

export const VEHICLE_RESIDUAL_CURVE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  SUPERSEDED: "已被替代"
};

export const VEHICLE_RESIDUAL_CURVE_METHOD_LABELS: Record<string, string> = {
  MANUAL: "手工曲线",
  ML_MODEL: "机器学习模型",
  STATISTICAL_MEDIAN: "统计中位数"
};

export const VEHICLE_RESIDUAL_FORECAST_STATUS_LABELS: Record<string, string> = {
  ADOPTED: "已采用",
  ARCHIVED: "已归档",
  GENERATED: "已生成",
  VOIDED: "已作废"
};

export const VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS: Record<string, string> = {
  CURVE_STATISTICAL: "统计曲线",
  MANUAL: "手工预测",
  ML_MODEL: "机器学习模型"
};

export const RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS: Record<string, string> = {
  EXACT: "精确匹配",
  LINEAR_INTERPOLATION: "线性插值",
  UNSUPPORTED_OUT_OF_RANGE: "超出曲线范围"
};

export const VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS: Record<string, string> = {
  ADOPTED: "已采用",
  GENERATED: "已生成",
  UNSUPPORTED: "暂不支持"
};

export const FORECAST_RESIDUAL_AMOUNT_SOURCE_LABELS: Record<string, string> = {
  ADOPTED: "人工采用",
  PREDICTED: "曲线预测"
};

export const MARKET_RESIDUAL_SOURCE_LABELS: Record<string, string> = {
  ADOPTED: "人工采用",
  NONE: "无可用残值",
  PREDICTED: "曲线预测"
};

export const RESIDUAL_MODEL_RUN_TYPE_LABELS: Record<string, string> = {
  EXTERNAL_MODEL: "外部模型",
  MANUAL_IMPORT: "手工导入",
  ML_INFERENCE: "机器学习推理",
  ML_TRAINING: "机器学习训练",
  STATISTICAL_BASELINE: "统计基线"
};

export const RESIDUAL_MODEL_RUN_STATUS_LABELS: Record<string, string> = {
  CANCELLED: "已取消",
  COMPLETED: "已完成",
  CREATED: "已创建",
  FAILED: "失败",
  RUNNING: "运行中"
};

export const RESIDUAL_MODEL_ALGORITHM_LABELS: Record<string, string> = {
  CATBOOST: "CatBoost",
  CUSTOM: "自定义",
  EXTERNAL: "外部模型",
  GRADIENT_BOOSTING: "梯度提升",
  LIGHTGBM: "LightGBM",
  LINEAR_REGRESSION: "线性回归",
  RANDOM_FOREST: "随机森林",
  STATISTICAL_MEDIAN: "统计中位数",
  UNKNOWN: "未知",
  XGBOOST: "XGBoost"
};

export const RESIDUAL_MODEL_TARGET_TYPE_LABELS: Record<string, string> = {
  CURVE_AND_FORECAST: "曲线与单车预测",
  MARKET_PRICE: "市场价格",
  RESIDUAL_CURVE: "残值曲线",
  VEHICLE_FORECAST: "单车预测"
};

export const RESIDUAL_MODEL_RUN_OUTPUT_TYPE_LABELS: Record<string, string> = {
  METRIC_REPORT: "指标报告",
  OTHER: "其他",
  RESIDUAL_CURVE: "残值曲线",
  VEHICLE_FORECAST: "单车预测"
};

export const RESIDUAL_MODEL_RUN_OUTPUT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "有效",
  VOIDED: "已作废"
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  ACTIVATE: "启用",
  APPROVE: "审批通过",
  CANCEL: "取消",
  CONFIRM: "确认",
  CREATE: "新建",
  DEACTIVATE: "停用",
  DELETE: "删除",
  DOWNLOAD: "下载",
  EXPORT: "导出",
  IMPORT: "导入",
  LOGIN: "登录",
  LOGOUT: "退出登录",
  REJECT: "审批拒绝",
  SUBMIT: "提交",
  UPDATE: "更新",
  UPLOAD: "上传"
};

export const ORDER_CHANGE_TYPE_LABELS: Record<string, string> = {
  CANCEL_ORDER: "取消订单",
  EXTENSION: "展期",
  PLAN_CHANGE: "方案变更 / 退回重做",
  RESTRUCTURE: "重组",
  TERMINATION: "终止",
  VEHICLE_SWAP: "换车"
};

export const MODULE_LABELS: Record<string, string> = {
  application: "进件管理",
  audit_log: "操作日志",
  auto_debit: "自动扣款",
  billing: "应收账单",
  business_exception: "业务例外审批",
  collection: "催收管理",
  contract: "合同管理",
  contract_template: "合同模板",
  customer: "客户中心",
  dashboard: "首页驾驶舱",
  deposit_ledger: "保证金台账",
  delivery: "车辆交付",
  payment: "收款核销",
  report: "经营报表",
  vehicle_return: "退车验收",
  order: "订单中心",
  order_change: "订单变更",
  subscription_change: "合同变更",
  subscription_closure: "订阅闭环",
  subscription_recovery: "车辆追回",
  subscription_early_termination: "提前终止",
  product: "产品中心",
  quote: "报价中心",
  residual_curve: "残值曲线",
  residual_forecast: "单车残值预测",
  residual_market: "市场残值样本",
  residual_model_run: "残值模型运行",
  risk: "风控中心",
  system: "系统管理",
  vehicle: "车辆资产",
  vehicle_cost_ledger: "车辆成本台账",
  vehicle_valuation_review: "车辆估值复核"
};

export const PERMISSION_LABELS: Record<string, string> = {
  "subscription_closure:view": "查看订阅闭环",
  "subscription_closure:prepare": "准备订阅闭环",
  "subscription_closure:receive": "确认车辆物理接收",
  "subscription_closure:inspect": "执行退车检查",
  "subscription_closure:settle": "执行最终结算与库存释放",
  "subscription_recovery:assess": "评估车辆追回",
  "subscription_recovery:approve": "审批车辆追回",
  "subscription_recovery:execute": "执行车辆追回",
  "subscription_early_termination:create": "发起提前终止",
  "subscription_early_termination:execute": "执行提前终止",
  "business_exception:approve": "审批业务例外",
  "business_exception:request": "发起业务例外审批",
  "business_exception:view": "查看业务例外审批",
  "application:manage": "编辑进件",
  "application:material_delete": "删除进件资料",
  "application:material_upload": "上传进件资料",
  "application:review": "审核进件",
  "application:submit": "提交进件",
  "application:view": "查看进件",
  "audit_log:view": "查看操作日志",
  "auto_debit:execute": "执行自动扣款",
  "auto_debit:manage": "管理自动扣款",
  "auto_debit:view": "查看自动扣款",
  "billing:generate": "生成应收账单",
  "billing:view": "查看应收账单",
  "collection:action_create": "新增催收动作",
  "collection:close": "关闭催收案件",
  "collection:refresh_overdue": "刷新逾期账单",
  "collection:view": "查看催收案件",
  "contract:archive": "归档合同",
  "contract:cancel": "取消合同",
  "contract:generate": "生成合同",
  "contract:sign": "签署合同",
  "contract:view": "查看合同",
  "contract_template:activate": "启用合同模板",
  "contract_template:create": "新增合同模板",
  "contract_template:update": "编辑合同模板",
  "contract_template:view": "查看合同模板",
  "customer:manage": "管理客户",
  "customer:view": "查看客户",
  "dashboard:view": "查看首页驾驶舱",
  "delivery:confirm": "确认车辆交付",
  "delivery:prepare": "准备车辆交付",
  "delivery:view": "查看车辆交付",
  "deposit_ledger:view": "查看保证金台账",
  "vehicle_return:confirm": "确认退车验收",
  "vehicle_return:damage_record": "记录退车损伤",
  "vehicle_return:prepare": "准备退车验收",
  "vehicle_return:view": "查看退车验收",
  "menu:view": "查看菜单",
  "notification:manage": "管理通知中心",
  "notification:view": "查看通知中心",
  "order:cancel": "取消订单",
  "order:confirm_final_plan": "确认最终方案",
  "order:create": "创建订单",
  "order:reject": "拒绝订单申请",
  "order:review": "审核订单申请",
  "order:update": "编辑订单",
  "order:view": "查看订单",
  "order_change:approve": "审批订单变更",
  "order_change:create": "创建订单变更",
  "order_change:execute": "执行订单变更",
  "order_change:reject": "拒绝订单变更",
  "order_change:view": "查看订单变更",
  "subscription_change:cancel": "取消合同变更",
  "subscription_change:create": "创建合同变更",
  "subscription_change:esign_retry": "重试合同变更电子签",
  "subscription_change:execute": "执行合同变更",
  "subscription_change:manual_takeover": "人工接管合同变更",
  "subscription_change:price_override_approve": "审批合同变更价格例外",
  "subscription_change:quote": "生成合同变更报价",
  "subscription_change:submit": "提交合同变更",
  "subscription_change:view": "查看合同变更",
  "permission:view": "查看权限",
  "payment:create": "登记收款",
  "payment:view": "查看收款记录",
  "payment:write_off": "收款核销",
  "product:activate": "启用产品",
  "product:create": "新建产品",
  "product:update": "编辑产品",
  "product:view": "查看产品",
  "product_price_rule:create": "新建价格规则",
  "product_price_rule:delete": "删除价格规则",
  "product_price_rule:update": "编辑价格规则",
  "product_price_rule:view": "查看价格规则",
  "product_version:activate": "激活产品版本",
  "product_version:approve": "审批产品版本",
  "product_version:create": "新建产品版本",
  "product_version:update": "编辑产品版本",
  "product_version:view": "查看产品版本",
  "quote:cancel": "取消报价",
  "quote:confirm": "确认报价",
  "quote:create": "新建报价",
  "quote:update": "编辑报价",
  "quote:view": "查看报价",
  "report:asset": "查看资产报表",
  "report:finance": "查看财务报表",
  "report:view": "查看经营报表",
  "financing:manage": "管理融资工具",
  "financing:view": "查看融资工具",
  "vehicle_asset_pool:manage": "管理车辆资产池",
  "vehicle_asset_pool:view": "查看车辆资产池",
  "revenue_right:manage": "管理收益权归属",
  "revenue_right:view": "查看收益权归属",
  "revenue_share:manage": "管理托管分润规则",
  "revenue_share:view": "查看托管分润规则",
  "residual_curve:generate": "生成残值曲线",
  "residual_curve:manage": "管理残值曲线",
  "residual_curve:view": "查看残值曲线",
  "residual_forecast:generate": "生成单车残值预测",
  "residual_forecast:manage": "管理单车残值预测",
  "residual_forecast:view": "查看单车残值预测",
  "residual_market:import": "导入市场残值样本",
  "residual_market:manage": "管理市场残值样本",
  "residual_market:view": "查看市场残值样本",
  "residual_model_run:manage": "管理残值模型运行记录",
  "residual_model_run:view": "查看残值模型运行记录",
  "vehicle_valuation_review:approve": "审核车辆估值复核",
  "vehicle_valuation_review:create": "发起车辆估值复核",
  "vehicle_valuation_review:view": "查看车辆估值复核",
  "capital_structure:manage": "管理车辆资本结构",
  "capital_structure:view": "查看车辆资本结构",
  "risk:manage": "管理押金规则",
  "risk:view": "查看风控",
  "role:manage": "管理角色",
  "role:view": "查看角色",
  "subscription_plan:activate": "启用订阅套餐",
  "subscription_plan:create": "新建订阅套餐",
  "subscription_plan:deactivate": "停用订阅套餐",
  "subscription_plan:delete": "删除订阅套餐",
  "subscription_plan:update": "编辑订阅套餐",
  "subscription_plan:view": "查看订阅套餐",
  "user:manage": "管理用户",
  "user:view": "查看用户",
  "vehicle:create": "新建车辆资产",
  "vehicle:delete": "删除车辆资产",
  "vehicle:history_view": "查看车辆销售价历史",
  "vehicle:initialize_sale_price": "初始化车辆销售价",
  "vehicle:manage": "管理车辆资产",
  "vehicle:review_sale_price": "复核车辆销售价",
  "vehicle:update": "编辑车辆资产",
  "vehicle:update_status": "更新车辆状态",
  "vehicle:view": "查看车辆资产",
  "vehicle_cost_ledger:confirm": "确认车辆成本台账",
  "vehicle_cost_ledger:reverse": "冲正车辆成本台账",
  "vehicle_cost_ledger:view": "查看车辆成本台账"
};

export const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "subscription_closure:view": "允许查看订阅闭环案件及审计投影",
  "subscription_closure:prepare": "允许准备退车闭环但不能确认物理接收",
  "subscription_closure:receive": "允许确认车辆已经物理接收",
  "subscription_closure:inspect": "允许记录退车检查、证据与实际成本",
  "subscription_closure:settle": "允许提出、确认、结清最终结算并释放库存",
  "subscription_recovery:assess": "允许评估追回上下文并发起追回审批",
  "subscription_recovery:approve": "允许独立审批车辆追回",
  "subscription_recovery:execute": "允许执行已审批追回并记录证据成本",
  "subscription_early_termination:create": "允许发起或取消执行前提前终止",
  "subscription_early_termination:execute": "允许执行已归档协议的提前终止",
  "business_exception:approve": "允许审批业务例外",
  "business_exception:request": "允许发起业务例外审批",
  "business_exception:view": "允许查看业务例外审批",
  "application:manage": "允许创建和编辑进件",
  "application:material_delete": "允许删除进件资料文件",
  "application:material_upload": "允许上传进件资料",
  "application:review": "允许进行进件审批和资料审核",
  "application:submit": "允许提交进件",
  "application:view": "允许查看进件列表和详情",
  "audit_log:view": "允许查看操作日志",
  "auto_debit:execute": "允许发起人工扣款、任务重试和结果查询",
  "auto_debit:manage": "允许同步、暂停和解除支付授权",
  "auto_debit:view": "允许查看支付授权、扣款尝试和异常状态",
  "billing:generate": "允许为订单生成初始应收账单",
  "billing:view": "允许查看订单财务概览和应收账单",
  "collection:action_create": "允许新增催收跟进动作",
  "collection:close": "允许关闭已结清的催收案件",
  "collection:refresh_overdue": "允许刷新逾期账单并创建催收案件",
  "collection:view": "允许查看逾期账单和催收案件",
  "contract:archive": "允许归档订阅合同",
  "contract:cancel": "允许取消订阅合同",
  "contract:generate": "允许从订阅订单生成合同",
  "contract:sign": "允许标记订阅合同签署",
  "contract:view": "允许查看合同管理",
  "contract_template:activate": "允许启用和停用合同模板",
  "contract_template:create": "允许新增合同模板",
  "contract_template:update": "允许编辑合同模板",
  "contract_template:view": "允许查看合同模板",
  "customer:manage": "允许新建和编辑客户",
  "customer:view": "允许查看客户列表和详情",
  "dashboard:view": "允许查看首页驾驶舱",
  "delivery:confirm": "允许确认车辆实际交付",
  "delivery:prepare": "允许维护车辆交付准备信息",
  "delivery:view": "允许查看订单车辆交付信息",
  "deposit_ledger:view": "允许查看保证金台账",
  "vehicle_return:confirm": "允许确认退车验收并记录退车结果",
  "vehicle_return:damage_record": "允许录入退车损伤记录",
  "vehicle_return:prepare": "允许维护退车预约和验收准备信息",
  "vehicle_return:view": "允许查看订单退车验收信息",
  "menu:view": "允许查看菜单管理",
  "notification:manage": "允许管理通知模板和发送记录",
  "notification:view": "允许查看通知中心",
  "order:cancel": "允许取消订阅订单",
  "order:confirm_final_plan": "允许确认客户自助订单最终方案",
  "order:create": "允许从已确认报价创建订阅订单",
  "order:reject": "允许拒绝客户自助订单申请",
  "order:review": "允许查看和处理客户自助订单审核",
  "order:update": "允许编辑订阅订单",
  "order:view": "允许查看订阅订单",
  "order_change:approve": "允许审批订单变更",
  "order_change:create": "允许创建订单变更申请",
  "order_change:execute": "允许执行已审批订单变更",
  "order_change:reject": "允许拒绝订单变更",
  "order_change:view": "允许查看订单变更",
  "permission:view": "允许查看权限清单",
  "payment:create": "允许登记客户收款",
  "payment:view": "允许查看收款记录",
  "payment:write_off": "允许将收款核销到应收账单",
  "product:activate": "允许启用和停用产品",
  "product:create": "允许新建产品",
  "product:update": "允许编辑产品",
  "product:view": "允许查看产品中心",
  "product_price_rule:create": "允许新建产品价格规则",
  "product_price_rule:delete": "允许删除产品价格规则",
  "product_price_rule:update": "允许编辑产品价格规则",
  "product_price_rule:view": "允许查看产品价格规则",
  "product_version:activate": "允许激活产品版本",
  "product_version:approve": "允许审批产品版本",
  "product_version:create": "允许新建产品版本",
  "product_version:update": "允许编辑产品版本",
  "product_version:view": "允许查看产品版本",
  "quote:cancel": "允许取消订阅报价",
  "quote:confirm": "允许确认订阅报价",
  "quote:create": "允许新建订阅报价",
  "quote:update": "允许编辑订阅报价",
  "quote:view": "允许查看订阅报价",
  "report:asset": "允许查看车辆资产运营报表",
  "report:finance": "允许查看财务应收实收、保证金和催收报表",
  "report:view": "允许查看经营总览和订单经营报表",
  "risk:manage": "允许维护押金规则",
  "risk:view": "允许查看风控中心",
  "role:manage": "允许维护角色权限和菜单",
  "role:view": "允许查看角色管理",
  "subscription_plan:activate": "允许启用订阅套餐",
  "subscription_plan:create": "允许新建订阅套餐",
  "subscription_plan:deactivate": "允许停用订阅套餐",
  "subscription_plan:delete": "允许删除订阅套餐",
  "subscription_plan:update": "允许编辑订阅套餐",
  "subscription_plan:view": "允许查看订阅套餐",
  "user:manage": "允许维护用户",
  "user:view": "允许查看用户管理",
  "vehicle:create": "允许新建车辆资产",
  "vehicle:delete": "允许删除车辆资产",
  "vehicle:history_view": "允许查看车辆销售价历史",
  "vehicle:initialize_sale_price": "允许初始化车辆当前销售价",
  "vehicle:manage": "允许维护车辆资产、状态和销售价",
  "vehicle:review_sale_price": "允许复核车辆当前销售价",
  "vehicle:update": "允许编辑车辆资产",
  "vehicle:update_status": "允许更新车辆状态",
  "vehicle:view": "允许查看车辆资产和销售价历史",
  "vehicle_cost_ledger:confirm": "允许确认车辆成本台账",
  "vehicle_cost_ledger:reverse": "允许冲正车辆成本台账",
  "vehicle_cost_ledger:view": "允许查看车辆成本台账",
  "residual_curve:generate": "允许试算和正式生成残值曲线",
  "residual_curve:manage": "允许启用和归档残值曲线",
  "residual_curve:view": "允许查看残值曲线列表和详情",
  "residual_forecast:generate": "允许试算和正式生成单车残值预测",
  "residual_forecast:manage": "允许采用预测点和作废预测记录",
  "residual_forecast:view": "允许查看车辆残值预测和历史记录",
  "residual_market:import": "允许通过 CSV 文本导入市场残值样本",
  "residual_market:manage": "允许手工创建和作废市场残值样本",
  "residual_market:view": "允许查看市场残值样本列表、详情和导入批次",
  "residual_model_run:manage": "允许创建模型运行记录并标记完成、失败或取消",
  "residual_model_run:view": "允许查看残值模型运行记录列表和详情",
  "vehicle_valuation_review:approve": "允许审核通过或拒绝车辆估值复核",
  "vehicle_valuation_review:create": "允许从残值预测点发起车辆估值复核并取消待审核复核",
  "vehicle_valuation_review:view": "允许查看车辆估值复核列表和详情"
};

export const MENU_LABELS: Record<string, string> = {
  applications: "进件管理",
  billing: "财务管理",
  "billing.collections": "逾期催收",
  "billing.financing_instruments": "融资工具",
  "billing.monthly_rent": "月租账单生成",
  "billing.revenue_rights": "收益权管理",
  customers: "客户中心",
  dashboard: "首页驾驶舱",
  orders: "订单中心",
  "orders.contract_templates": "合同模板",
  "orders.contracts": "合同管理",
  "orders.mileage_reviews": "里程复核",
  "orders.notifications": "通知中心",
  "orders.review": "旧版订单审核",
  "orders.subscription": "订阅订单",
  "orders.subscription_changes": "合同变更中心",
  products: "产品中心",
  quotes: "订阅报价",
  reports: "经营看板",
  "reports.asset_profitability": "资产经营分析",
  "reports.overview": "经营总览",
  risk: "风控中心",
  "risk.deposit_rules": "押金规则",
  system: "系统管理",
  "system.audit_logs": "操作日志",
  "system.permissions": "权限管理",
  "system.roles": "角色管理",
  "system.users": "用户管理",
  vehicles: "车辆资产",
  "vehicles.asset_pools": "车辆资产池",
  "vehicles.assets": "车辆资产台账",
  "vehicles.model_definitions": "车型代码",
  "vehicles.residual_market": "市场残值样本",
  "vehicles.valuation_reviews": "估值复核"
};

export function labelOf(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return labels[value] ?? value;
}

export function localizeMenuLabel(menu: MenuItemDefinition) {
  return MENU_LABELS[menu.code] ?? menu.label;
}
