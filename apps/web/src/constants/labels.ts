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
  PENDING_REVIEW: "待订单审核",
  PENDING_SIGN: "待签署",
  PENDING_VEHICLE: "待分车",
  REJECTED: "已拒绝",
  RENTED: "已租赁",
  RESERVED: "签约锁定（待交付）",
  RETIRED: "已退役",
  RETURNED: "已退回",
  REVIEW_RESERVED: "审核占用",
  REVIEW_DUE: "待复核",
  SIGNED: "已签署",
  SIGNING: "签署中",
  SUBMITTED: "已提交",
  SUSPENDED: "暂停",
  TERMINATED: "已终止",
  UNDER_REVIEW: "审批中"
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

export const VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  INACTIVE: "已停用"
};

export const VEHICLE_DEPRECIATION_METHOD_LABELS: Record<string, string> = {
  MANUAL: "手工口径",
  NONE: "不计提",
  STRAIGHT_LINE: "直线法"
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
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
  RETURN_REINIT: "退车再入池重新定价"
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
  billing: "应收账单",
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
  product: "产品中心",
  quote: "报价中心",
  risk: "风控中心",
  system: "系统管理",
  vehicle: "车辆资产"
};

export const PERMISSION_LABELS: Record<string, string> = {
  "application:manage": "编辑进件",
  "application:material_delete": "删除进件资料",
  "application:material_upload": "上传进件资料",
  "application:review": "审核进件",
  "application:submit": "提交进件",
  "application:view": "查看进件",
  "audit_log:view": "查看操作日志",
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
  "vehicle:view": "查看车辆资产"
};

export const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "application:manage": "允许创建和编辑进件",
  "application:material_delete": "允许删除进件资料文件",
  "application:material_upload": "允许上传进件资料",
  "application:review": "允许进行进件审批和资料审核",
  "application:submit": "允许提交进件",
  "application:view": "允许查看进件列表和详情",
  "audit_log:view": "允许查看操作日志",
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
  "vehicle:view": "允许查看车辆资产和销售价历史"
};

export const MENU_LABELS: Record<string, string> = {
  applications: "进件管理",
  billing: "财务管理",
  "billing.collections": "逾期催收",
  "billing.monthly_rent": "月租账单生成",
  customers: "客户中心",
  dashboard: "首页驾驶舱",
  orders: "订单中心",
  "orders.contract_templates": "合同模板",
  "orders.contracts": "合同管理",
  "orders.review": "旧版订单审核",
  "orders.subscription": "订阅订单",
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
  vehicles: "车辆资产"
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
