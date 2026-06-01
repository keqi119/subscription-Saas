# 纯电汽车订阅运营中台 V1.0 开发文档

> 项目名称：上海二手纯电汽车订阅运营中台  
> 业务场景：中国大陆境内，以上海为首发城市，基于 2–3 年车龄二手纯电车型先开展汽车订阅业务；以租代购作为未来产品线保留扩展能力  
> 初始车型：蔚来 ET5 / ET7 / ES6，电池买断  
> 核心目标：支撑客户进件、风控评级、订阅方案、合同签署、车辆整备、车辆交付、账务催收、保证金池、资产运营、ROA/ROE 经营分析  
> 文档用途：作为 Codex / 研发团队 / 产品经理 / 测试团队的需求基线文档  
> 开发原则：先做运营中台 Back Office，不优先做用户端 App；先跑通业务闭环，再做自动化和智能化。

---

## 0. 给 Codex 的总体开发指令

你是一名资深全栈工程师，需要基于本开发文档实现一个“纯电汽车订阅运营中台 V1.0”。

请严格遵守：

1. 先阅读本文件全文，再制定实现计划。
2. 不要一次性实现全部功能，应按阶段逐步提交。
3. 每个阶段必须包含：数据模型、后端接口、后台管理页面、基础权限控制、单元测试或最小验证脚本。
4. 不要删除已有功能，只能在明确需求下增量修改。
5. 所有核心业务状态必须使用枚举，不允许用散乱字符串。
6. 所有金额字段统一使用“分”为单位存储，页面展示时转换为“元”。
7. 所有时间字段统一存储为 UTC，页面按 Asia/Shanghai 展示。
8. 涉及客户身份、合同、车辆资产、账务、保证金的数据必须保留审计日志。
9. 所有关键表必须包含 id、created_at、updated_at、created_by、updated_by、deleted_at。
10. 交付代码前必须运行 lint、typecheck、test、migration dry-run 或 schema validation。
11. 输出结果时请说明修改文件、新增功能、启动方式、测试方式、未完成事项。

---

## 1. 项目背景

本项目服务于上海区域纯电汽车订阅业务。业务方计划采购 2–3 年车龄的二手纯电车辆，主要车型为 ET5、ET7、ES6，车辆采用电池买断形式，登记为沪牌绿牌。客户通过订阅方式获得车辆使用权，可按月支付订阅费用，同时享有里程包、补能包、换车权益、洗车权益、积分等服务权益。

项目的商业本质不是单纯租车，而是“资产运营 + 资金杠杆 + 风控定价 + 残值管理”的综合业务。因此系统必须同时服务于销售获客、客户进件、风控审批、产品方案、合同管理、车辆资产、交付履约、账单催收、保证金池、权益管理、经营分析与资金方报送。

### 1.1 当前开发聚焦与长期产品线预留

当前开发阶段只开放 `SUBSCRIPTION` 订阅业务，优先跑通“客户 → 进件 → 风控 → 评级 → 订阅报价 → 确认报价 → 订单/交付”的主流程。`RENT_TO_OWN` 以租代购产品线保留在底层枚举、字段、权限和历史数据中，但当前阶段不展示入口、不允许创建报价、订单或合同。

长期架构不应把车辆资产绑定到单一产品线。同一台车未来可能经历订阅、空置、维修、再订阅、以租代购、提前买断、出售退出等多个经营阶段。系统最终应按车辆完整生命周期评估资产运营质量，而不是只按某一个产品线或某一张订单评估收益。

### 1.2 车辆生命周期资产运营模型

系统长期分为两层：

```text
资产层
+
产品/订单层
```

资产层以 `Vehicle` 为核心对象，关注车辆采购价、采购时间、车况、保险、维修、空置、经营阶段、退出残值、生命周期总收入、生命周期总成本、单车 ROA 与 IRR。产品/订单层表示车辆在某个阶段采用的经营方式，当前阶段仅实现订阅，未来可在同一资产生命周期模型下扩展以租代购。

未来建议新增 `vehicle_lifecycle_event` 表，用于记录单车完整经营轨迹：

```text
id
vehicle_id
event_type
business_type
related_order_id
related_quote_id
start_date
end_date
revenue_amount
cost_amount
mileage_start
mileage_end
vehicle_status_before
vehicle_status_after
remark
created_at
updated_at
created_by
updated_by
deleted_at
```

`business_type` 建议支持：

```text
SUBSCRIPTION
RENT_TO_OWN
IDLE
MAINTENANCE
DISPOSAL
OTHER
```

`event_type` 建议支持：

```text
PURCHASE
PREPARE
SUBSCRIPTION_START
SUBSCRIPTION_END
RENT_TO_OWN_START
RENT_TO_OWN_END
IDLE_START
IDLE_END
MAINTENANCE_START
MAINTENANCE_END
RETURN
DISPOSAL
SALE
BUYOUT
```

该表建议在资产中心阶段实现；在重新开放以租代购产品线前，应先完成车辆生命周期事件和单车资产质量分析。

---

## 2. V1.0 建设目标

### 2.1 业务目标

V1.0 需要支撑 500 台车队规模的基础运营，至少覆盖：

- 客户从线索到进件
- 客户 A/B/C 分级
- 按等级配置押金和违约率
- 订阅方案生成
- 合同制作、签署状态、归档
- 车辆采购、整备、上牌、保险、交付
- 月度账单生成
- 收款核销
- 逾期催收
- 保证金收取、冻结、扣减、退还
- 用户权益配置与消耗
- 车辆退回、再整备、再次出租、退出出售
- 订单报表、资产质量报表、收入报表、保证金池报表、ROA/ROE 报表

### 2.2 技术目标

- 建立清晰的数据模型
- 建立稳定的状态机
- 建立可扩展的审批流
- 建立可追踪的操作审计
- 支持后台人工操作
- 支持后续接入移动端、电子签、支付、GPS、OCR、征信、银行代扣等外部服务

---

## 3. 推荐技术栈

如已有项目技术栈，应优先沿用现有栈；若从零开始，建议：

### 3.1 前端

- Next.js 或 React
- TypeScript
- Ant Design / Arco Design / shadcn/ui
- TanStack Query
- 表格组件支持筛选、排序、导出
- 权限控制到菜单和按钮级别

### 3.2 后端

任选其一：

- Node.js + NestJS + Prisma
- Python + FastAPI + SQLAlchemy
- Java + Spring Boot + MyBatis Plus

推荐中小团队优先使用：

```text
Next.js + NestJS + PostgreSQL + Prisma
```

### 3.3 数据库与基础设施

- PostgreSQL
- Redis，用于缓存、任务锁、验证码、异步任务状态
- 对象存储，用于合同、证件、车辆照片、交付照片
- BullMQ / Celery / Quartz，用于月账单生成、逾期计算、报表快照、提醒任务

---

## 4. 角色与权限

### 4.1 组织角色

| 角色代码 | 角色名称 | 主要职责 |
|---|---|---|
| SA | 销售顾问 | 获客、进件、方案沟通 |
| OP | 运营管理 | 产品、合同、订单、权益 |
| RC | 风控专员 | 客户评级、审批、逾期、欺诈 |
| FI | 财务专员 | 收款、核销、保证金、报表 |
| AS | 资产运营 | 车辆采购、整备、交付、回收 |
| CS | 客服运营 | 回访、续订、退车协调 |
| GM | 总经理/运营总监 | 产品、特殊审批、重大风险审批 |
| ADMIN | 系统管理员 | 用户、角色、权限、系统配置 |

### 4.2 权限原则

- 销售只能查看自己客户，主管可查看团队客户。
- 风控可查看客户资质与审批信息。
- 财务可查看账单、收款、保证金，不应修改风控结果。
- 资产运营可操作车辆、整备、交付、回收，不应修改客户审批结果。
- 运营管理可管理产品、合同、订单变更。
- 总经理拥有特殊审批权限。
- 所有关键操作写入 audit_log。

---

## 5. RACI 职责矩阵

### 5.1 产品管理

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 产品设计 | I | R | C | C | C | A |
| 产品调价 | I | R | C | C | C | A |
| 产品培训 | I | A/R | I | I | I | I |
| 产品上线 | I | R | C | C | C | A |

### 5.2 客户准入

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 客户资料收集 | R | I | I | I | I | I |
| 客户进件 | R | C | I | I | I | I |
| 客户评级 | I | I | R | I | I | A |
| 风险审批 | I | I | R | I | I | A |
| 特殊客户审批 | I | I | R | I | I | A |

### 5.3 合同管理

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 合同制作 | I | R | I | I | I | I |
| 合同审核 | I | R | C | I | I | A |
| 合同签署 | R | A | I | I | I | I |
| 合同归档 | I | R | I | I | I | I |
| 合同变更 | I | R | C | I | I | A |
| 提前买断 | I | R | C | C | I | A |
| 合同终止 | I | R | C | C | I | A |

### 5.4 订单履约

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 创建订单 | R | A | I | I | I | I |
| 方案审批 | I | R | C | I | I | A |
| 收款确认 | I | I | I | R | I | A |
| 车辆匹配 | I | C | I | I | R | A |
| 交付审批 | I | R | I | C | C | A |
| 车辆交付 | I | I | I | I | R | A |
| 订单变更 | I | R | C | C | C | A |

### 5.5 账务管理

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 账单生成 | I | R | I | A | I | I |
| 账单发送 | I | R | I | A | I | I |
| 催收管理 | C | R | C | A | I | I |
| 账单核销 | I | I | I | R/A | I | I |
| 保证金收取 | I | I | I | R/A | I | I |
| 保证金退还 | I | C | I | R | I | A |
| 服务费统计 | I | C | I | R/A | I | I |

### 5.6 资产管理

| 事项 | SA | OP | RC | FI | AS | GM |
|---|---|---|---|---|---|---|
| 车辆采购申请 | I | C | I | C | R | A |
| 车辆验收 | I | I | I | I | R | A |
| 车辆整备 | I | I | I | I | R/A | I |
| 车辆上牌 | I | I | I | C | R | A |
| 保险购买 | I | I | I | C | R | A |
| 车辆交付 | I | I | I | I | R/A | I |
| 车辆回收 | I | I | I | I | R/A | I |
| 车辆出售 | I | I | I | C | R | A |

---

## 6. 业务流程设计

### 6.1 L1 主流程

```text
产品管理
  ↓
客户获取
  ↓
客户准入
  ↓
订单履约
  ↓
资产运营
  ↓
资金回收
  ↓
退车 / 续订 / 买断 / 车辆退出
```

### 6.2 客户进件流程

```text
线索录入 → 销售初筛 → 资料收集 → 提交进件 → 风控审核 → 客户评级 A/B/C → 押金和违约率匹配 → 审批通过 / 补件 / 拒绝
```

### 6.3 订单履约流程

```text
审批通过 → 生成订阅方案 → 客户确认 → 合同生成 → 合同签署 → 押金和首期月费到账 → 车辆匹配 → 车辆整备 → 交付前审核 → 现场交付 → 进入在租状态
```

### 6.4 账单与催收流程

```text
合同生效 → 生成账单计划 → 每月账单生成 → 发送账单 → 客户付款/自动扣款 → 财务核销 → 逾期识别 → M1/M2/M3 催收 → 违约处置/车辆回收/法务
```

### 6.5 退车流程

```text
客户申请退车 → 运营确认合同条件 → 安排退车时间地点 → 资产人员验车 → 确认里程、电量、损伤、违章 → 生成退车结算单 → 保证金扣减或退还 → 车辆进入再整备/维修/出售
```

---

## 7. 状态机设计

### 7.1 客户状态 customer.status

| 状态 | 说明 |
|---|---|
| LEAD | 线索 |
| PENDING_APPLICATION | 待进件 |
| UNDER_REVIEW | 审批中 |
| APPROVED | 已通过 |
| REJECTED | 已拒绝 |
| ACTIVE | 活跃客户 |
| FROZEN | 冻结 |
| BLACKLISTED | 黑名单 |

### 7.2 进件状态 application.status

| 状态 | 说明 |
|---|---|
| DRAFT | 草稿 |
| SUBMITTED | 已提交 |
| NEED_MORE_INFO | 补件 |
| APPROVED | 通过 |
| REJECTED | 拒绝 |
| CANCELLED | 取消 |

### 7.3 订单状态 order.status

| 状态 | 说明 |
|---|---|
| QUOTED | 已报价 |
| PENDING_CONTRACT | 待签约 |
| PENDING_PAYMENT | 待付款 |
| PENDING_VEHICLE | 待分车 |
| PENDING_DELIVERY | 待交付 |
| ACTIVE | 在租 |
| OVERDUE | 逾期 |
| SUSPENDED | 暂停 |
| TERMINATED | 已终止 |
| COMPLETED | 已完成 |
| BUYOUT | 已买断 |

### 7.4 车辆状态 vehicle.asset_status

| 状态 | 说明 |
|---|---|
| PURCHASED | 已采购 |
| PENDING_INSPECTION | 待验收 |
| PENDING_PREPARE | 待整备 |
| AVAILABLE | 可出租 |
| RESERVED | 已预留 |
| DELIVERED | 已交付 |
| IN_USE | 在租 |
| MAINTENANCE | 维修中 |
| RETURNED | 已回收 |
| DISPOSAL_PENDING | 待出售 |
| SOLD | 已出售 |
| SCRAPPED | 已报废 |

### 7.5 账单状态 bill.status

| 状态 | 说明 |
|---|---|
| PENDING | 待收 |
| PARTIAL_PAID | 部分收款 |
| PAID | 已结清 |
| OVERDUE | 逾期 |
| WRITTEN_OFF | 已核销 |
| CANCELLED | 已取消 |

### 7.6 保证金状态 deposit_account.status

| 状态 | 说明 |
|---|---|
| PENDING | 待收 |
| ACTIVE | 正常 |
| PARTIALLY_FROZEN | 部分冻结 |
| FROZEN | 冻结 |
| REFUNDING | 退款中 |
| REFUNDED | 已退还 |
| DEDUCTED | 已扣减关闭 |

---

## 8. 数据库通用规则

- 表名使用 snake_case。
- 主键统一使用 id。
- 外键使用 `{entity}_id`。
- 金额字段使用 `_amount` 或 `_fee` 后缀，单位为分。
- 比率字段使用 decimal，例：0.035 表示 3.5%。
- 所有核心表默认包含：id、created_at、updated_at、created_by、updated_by、deleted_at。
- 所有状态字段必须使用枚举。
- 所有核心业务表应支持软删除。
- 所有关键业务变化必须写入 audit_log。

---

## 9. 客户中心表

### 9.1 customer 客户主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 客户ID |
| customer_no | varchar(64) | 是 | 客户编号 |
| name | varchar(64) | 是 | 客户姓名 |
| mobile | varchar(32) | 是 | 手机号 |
| customer_type | enum | 是 | PERSONAL / COMPANY |
| source_channel | varchar(64) | 否 | 来源渠道 |
| grade | enum | 否 | A / B / C |
| risk_score | int | 否 | 风控评分 |
| status | enum | 是 | 客户状态 |
| owner_user_id | uuid | 否 | 所属销售 |
| remark | text | 否 | 备注 |

### 9.2 customer_identity 身份信息表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| id_card_no | varchar(32) | 是 | 身份证号 |
| id_card_front_file_id | uuid | 否 | 身份证正面 |
| id_card_back_file_id | uuid | 否 | 身份证反面 |
| driver_license_no | varchar(64) | 是 | 驾驶证号 |
| driver_license_file_id | uuid | 否 | 驾驶证文件 |
| license_valid_until | date | 否 | 驾驶证有效期 |
| realname_verified | boolean | 是 | 是否实名 |
| verified_at | timestamp | 否 | 核验时间 |

### 9.3 customer_profile 客户画像表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| occupation | varchar(128) | 否 | 职业 |
| company_name | varchar(128) | 否 | 工作单位 |
| monthly_income_amount | bigint | 否 | 月收入，分 |
| social_security_months | int | 否 | 社保月份 |
| housing_fund_months | int | 否 | 公积金月份 |
| residence_address | varchar(255) | 否 | 居住地址 |
| emergency_contact_name | varchar(64) | 否 | 紧急联系人 |
| emergency_contact_mobile | varchar(32) | 否 | 紧急联系人电话 |

### 9.4 customer_followup 跟进记录表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| followup_user_id | uuid | 是 | 跟进人 |
| followup_type | enum | 是 | PHONE / WECHAT / VISIT / OTHER |
| content | text | 是 | 跟进内容 |
| next_followup_at | timestamp | 否 | 下次跟进时间 |

---

## 10. 进件与风控表

### 10.1 application 进件主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 进件ID |
| application_no | varchar(64) | 是 | 进件编号 |
| customer_id | uuid | 是 | 客户ID |
| sales_user_id | uuid | 是 | 销售ID |
| intended_model | varchar(64) | 否 | 意向车型 |
| intended_period_months | int | 否 | 订阅周期 |
| status | enum | 是 | DRAFT / SUBMITTED / NEED_MORE_INFO / APPROVED / REJECTED |
| submitted_at | timestamp | 否 | 提交时间 |
| approved_at | timestamp | 否 | 审批时间 |
| rejected_reason | text | 否 | 拒绝原因 |

### 10.2 application_material 进件材料表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| application_id | uuid | 是 | 进件ID |
| material_type | enum | 是 | ID_CARD / DRIVER_LICENSE / BANK_FLOW / WORK_PROOF / CREDIT_AUTH / OTHER |
| file_id | uuid | 是 | 文件ID |
| status | enum | 是 | PENDING / VERIFIED / REJECTED |
| review_remark | text | 否 | 审核备注 |

### 10.3 risk_result 风控结果表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 风控结果ID |
| application_id | uuid | 是 | 进件ID |
| customer_id | uuid | 是 | 客户ID |
| score | int | 否 | 风控评分 |
| grade | enum | 是 | A / B / C |
| approved_deposit_amount | bigint | 是 | 审批押金，分 |
| default_rate | decimal(8,6) | 是 | 预计违约率 |
| max_vehicle_purchase_price_amount | bigint | 否 | 可承租车辆采购价上限 |
| result | enum | 是 | APPROVED / REJECTED / NEED_MORE_INFO |
| remark | text | 否 | 审批意见 |
| approved_by | uuid | 否 | 审批人 |
| approved_at | timestamp | 否 | 审批时间 |

### 10.4 deposit_rule 押金规则表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 规则ID |
| grade | enum | 是 | A / B / C |
| deposit_amount | bigint | 是 | 押金，分 |
| customer_ratio | decimal(8,6) | 否 | 模型测算用客户占比 |
| default_rate | decimal(8,6) | 是 | 违约率 |
| effective_from | date | 是 | 生效日期 |
| effective_to | date | 否 | 失效日期 |
| status | enum | 是 | ACTIVE / INACTIVE |

---

## 11. 产品与方案表

### 11.1 product 产品主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 产品ID |
| product_no | varchar(64) | 是 | 产品编号 |
| name | varchar(128) | 是 | 产品名称 |
| product_type | enum | 是 | 当前阶段只允许 SUBSCRIPTION；RENT_TO_OWN 保留为未来扩展值，暂不开放创建 |
| status | enum | 是 | DRAFT / ACTIVE / INACTIVE |
| description | text | 否 | 说明 |

### 11.2 product_version 产品版本表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 版本ID |
| product_id | uuid | 是 | 产品ID |
| version_no | varchar(32) | 是 | 版本号 |
| effective_from | date | 是 | 生效日期 |
| effective_to | date | 否 | 失效日期 |
| approved_by | uuid | 否 | 审批人 |
| status | enum | 是 | DRAFT / APPROVED / ACTIVE / INACTIVE |

### 11.3 product_price_rule 价格规则表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| product_version_id | uuid | 是 | 产品版本ID |
| vehicle_model | varchar(64) | 是 | ET5 / ET7 / ES6 |
| monthly_fee_rate | decimal(8,6) | 是 | 月费率，默认 0.035 |
| min_period_months | int | 是 | 最短周期 |
| max_period_months | int | 是 | 最长周期 |
| base_mileage_km | int | 是 | 基础月里程 |
| over_mileage_fee_amount | bigint | 是 | 超里程费用，分/km |
| energy_limit_kwh | int | 否 | 月补能额度 |
| energy_limit_count | int | 否 | 月补能次数 |

### 11.4 subscription_quote 报价方案表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 报价ID |
| quote_no | varchar(64) | 是 | 报价编号 |
| application_id | uuid | 是 | 进件ID |
| customer_id | uuid | 是 | 客户ID |
| product_version_id | uuid | 是 | 产品版本ID |
| vehicle_model | varchar(64) | 是 | 车型 |
| vehicle_purchase_price_amount | bigint | 是 | 对应车辆采购价，分 |
| monthly_fee_amount | bigint | 是 | 月费，分 |
| deposit_amount | bigint | 是 | 押金，分 |
| period_months | int | 是 | 订阅周期 |
| mileage_limit_km | int | 是 | 月里程 |
| energy_package_id | uuid | 否 | 补能包 |
| status | enum | 是 | DRAFT / CONFIRMED / EXPIRED / CANCELLED |

---

## 12. 订单与合同表

### 12.1 subscription_order 订单主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 订单ID |
| order_no | varchar(64) | 是 | 订单编号 |
| customer_id | uuid | 是 | 客户ID |
| application_id | uuid | 是 | 进件ID |
| quote_id | uuid | 是 | 报价ID |
| vehicle_id | uuid | 否 | 分配车辆 |
| contract_id | uuid | 否 | 合同ID |
| monthly_fee_amount | bigint | 是 | 月费，分 |
| deposit_amount | bigint | 是 | 押金，分 |
| period_months | int | 是 | 订阅周期 |
| mileage_limit_km | int | 是 | 月里程 |
| status | enum | 是 | 订单状态 |
| start_date | date | 否 | 起租日 |
| end_date | date | 否 | 到期日 |
| actual_delivery_at | timestamp | 否 | 实际交付时间 |

### 12.2 order_change 订单变更表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| order_id | uuid | 是 | 订单ID |
| change_type | enum | 是 | PLAN_CHANGE / RESTRUCTURE / VEHICLE_SWAP / EXTENSION / TERMINATION / BUYOUT |
| before_snapshot | jsonb | 是 | 变更前 |
| after_snapshot | jsonb | 是 | 变更后 |
| reason | text | 是 | 原因 |
| status | enum | 是 | PENDING / APPROVED / REJECTED / EXECUTED |
| approved_by | uuid | 否 | 审批人 |
| approved_at | timestamp | 否 | 审批时间 |

### 12.3 contract 合同主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 合同ID |
| contract_no | varchar(64) | 是 | 合同编号 |
| order_id | uuid | 是 | 订单ID |
| customer_id | uuid | 是 | 客户ID |
| contract_version_id | uuid | 是 | 模板版本ID |
| status | enum | 是 | DRAFT / SIGNING / SIGNED / ARCHIVED / TERMINATED |
| signed_at | timestamp | 否 | 签署时间 |
| archived_at | timestamp | 否 | 归档时间 |
| file_id | uuid | 否 | 合同文件 |

### 12.4 contract_version 合同模板版本表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 版本ID |
| template_name | varchar(128) | 是 | 模板名称 |
| version_no | varchar(32) | 是 | 版本号 |
| effective_from | date | 是 | 生效日期 |
| file_id | uuid | 是 | 模板文件 |
| status | enum | 是 | DRAFT / ACTIVE / INACTIVE |
| approved_by | uuid | 否 | 审批人 |

---

## 13. 车辆资产表

### 13.1 vehicle 车辆主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 车辆ID |
| vehicle_no | varchar(64) | 是 | 车辆编号 |
| vin | varchar(64) | 是 | VIN |
| plate_no | varchar(32) | 否 | 车牌 |
| brand | varchar(64) | 是 | 品牌 |
| model | varchar(64) | 是 | 车型 |
| config_name | varchar(128) | 否 | 配置 |
| color | varchar(64) | 否 | 颜色 |
| new_car_price_amount | bigint | 否 | 新车参考价，分 |
| purchase_price_amount | bigint | 是 | 采购价，分 |
| battery_buyout | boolean | 是 | 是否电池买断 |
| registration_date | date | 否 | 首次登记日期 |
| purchase_date | date | 是 | 采购日期 |
| current_mileage_km | int | 是 | 当前里程 |
| battery_soh | decimal(6,3) | 否 | 电池健康度 |
| asset_status | enum | 是 | 资产状态 |
| current_order_id | uuid | 否 | 当前订单 |

### 13.2 vehicle_purchase 车辆采购表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| vehicle_id | uuid | 是 | 车辆ID |
| supplier_name | varchar(128) | 否 | 供应商 |
| purchase_price_amount | bigint | 是 | 采购价，分 |
| purchase_tax_amount | bigint | 否 | 税费 |
| acquisition_cost_amount | bigint | 否 | 上牌等生成成本 |
| finance_scheme_id | uuid | 否 | 融资方案 |
| expected_exit_price_amount | bigint | 否 | 预计退出价 |
| expected_holding_months | int | 否 | 预计持有月数 |

### 13.3 vehicle_condition 车况检测表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| vehicle_id | uuid | 是 | 车辆ID |
| inspection_type | enum | 是 | PURCHASE / DELIVERY / RETURN / PERIODIC |
| exterior_status | enum | 是 | GOOD / MINOR_DAMAGE / MAJOR_DAMAGE |
| interior_status | enum | 是 | GOOD / MINOR_DAMAGE / MAJOR_DAMAGE |
| tire_status | enum | 是 | GOOD / NEED_REPLACE |
| brake_status | enum | 是 | GOOD / NEED_REPAIR |
| battery_soh | decimal(6,3) | 否 | SOH |
| fault_codes | text | 否 | 故障码 |
| inspector_id | uuid | 是 | 检测人 |
| inspected_at | timestamp | 是 | 检测时间 |
| remark | text | 否 | 备注 |

### 13.4 vehicle_insurance 保险表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| vehicle_id | uuid | 是 | 车辆ID |
| insurance_company | varchar(128) | 是 | 保险公司 |
| policy_no | varchar(128) | 是 | 保单号 |
| premium_amount | bigint | 是 | 保费，分 |
| start_date | date | 是 | 起期 |
| end_date | date | 是 | 止期 |
| policy_file_id | uuid | 否 | 保单文件 |

### 13.5 vehicle_maintenance 维修保养表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| vehicle_id | uuid | 是 | 车辆ID |
| order_id | uuid | 否 | 关联订单 |
| type | enum | 是 | MAINTENANCE / REPAIR / CLEANING / TIRE / BATTERY / OTHER |
| cost_amount | bigint | 是 | 成本，分 |
| vendor_name | varchar(128) | 否 | 供应商 |
| start_at | timestamp | 否 | 开始时间 |
| completed_at | timestamp | 否 | 完成时间 |
| remark | text | 否 | 备注 |

---

## 14. 交付与回收表

### 14.1 delivery_order 交付单

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| delivery_no | varchar(64) | 是 | 交付单号 |
| order_id | uuid | 是 | 订单ID |
| vehicle_id | uuid | 是 | 车辆ID |
| customer_id | uuid | 是 | 客户ID |
| scheduled_at | timestamp | 是 | 计划交付时间 |
| delivery_location | varchar(255) | 是 | 交付地点 |
| status | enum | 是 | PENDING / READY / DELIVERED / CANCELLED |
| delivered_at | timestamp | 否 | 实际交付时间 |

### 14.2 handover_record 交接记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| delivery_order_id | uuid | 是 | 交付单 |
| mileage_km | int | 是 | 交车里程 |
| battery_percent | int | 是 | 交车电量 |
| existing_damage_desc | text | 否 | 已有损伤说明 |
| customer_signature_file_id | uuid | 否 | 客户签名 |
| staff_signature_file_id | uuid | 否 | 工作人员签名 |
| signed_at | timestamp | 是 | 签署时间 |

### 14.3 return_order 退车单

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| return_no | varchar(64) | 是 | 退车单号 |
| order_id | uuid | 是 | 订单ID |
| vehicle_id | uuid | 是 | 车辆ID |
| customer_id | uuid | 是 | 客户ID |
| scheduled_at | timestamp | 是 | 预约退车时间 |
| return_location | varchar(255) | 是 | 退车地点 |
| status | enum | 是 | PENDING / INSPECTED / SETTLED / CANCELLED |
| returned_at | timestamp | 否 | 实际退车时间 |

### 14.4 damage_record 损伤记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| return_order_id | uuid | 否 | 退车单 |
| vehicle_id | uuid | 是 | 车辆ID |
| order_id | uuid | 否 | 订单 |
| damage_type | enum | 是 | SCRATCH / DENT / GLASS / WHEEL / INTERIOR / OTHER |
| description | text | 是 | 描述 |
| estimated_cost_amount | bigint | 否 | 预估费用 |
| confirmed_cost_amount | bigint | 否 | 确认费用 |
| responsible_party | enum | 否 | CUSTOMER / COMPANY / THIRD_PARTY / UNKNOWN |

---

## 15. 账务与保证金表

### 15.1 bill 账单主表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | 账单ID |
| bill_no | varchar(64) | 是 | 账单号 |
| order_id | uuid | 是 | 订单ID |
| customer_id | uuid | 是 | 客户ID |
| bill_period_start | date | 是 | 账期开始 |
| bill_period_end | date | 是 | 账期结束 |
| due_date | date | 是 | 应付日期 |
| bill_amount | bigint | 是 | 应收金额，分 |
| paid_amount | bigint | 是 | 已收金额，分 |
| unpaid_amount | bigint | 是 | 未收金额，分 |
| status | enum | 是 | 账单状态 |
| overdue_days | int | 是 | 逾期天数 |

### 15.2 bill_item 账单明细

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| bill_id | uuid | 是 | 账单ID |
| item_type | enum | 是 | MONTHLY_FEE / DEPOSIT / MILEAGE / ENERGY / DAMAGE / VIOLATION / SERVICE_FEE / OTHER |
| item_name | varchar(128) | 是 | 名称 |
| amount | bigint | 是 | 金额，分 |
| remark | text | 否 | 备注 |

### 15.3 payment 收款记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| payment_no | varchar(64) | 是 | 收款单号 |
| customer_id | uuid | 是 | 客户ID |
| order_id | uuid | 否 | 订单ID |
| bill_id | uuid | 否 | 账单ID |
| amount | bigint | 是 | 金额，分 |
| payment_method | enum | 是 | WECHAT / ALIPAY / BANK_TRANSFER / AUTO_DEBIT / CASH |
| paid_at | timestamp | 是 | 付款时间 |
| status | enum | 是 | PENDING / SUCCESS / FAILED / REFUNDED |

### 15.4 writeoff_record 核销记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| bill_id | uuid | 是 | 账单ID |
| payment_id | uuid | 是 | 收款ID |
| amount | bigint | 是 | 核销金额，分 |
| writeoff_at | timestamp | 是 | 核销时间 |
| writeoff_by | uuid | 是 | 核销人 |

### 15.5 deposit_account 保证金账户

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| order_id | uuid | 是 | 订单ID |
| required_amount | bigint | 是 | 应收押金，分 |
| received_amount | bigint | 是 | 已收押金，分 |
| frozen_amount | bigint | 是 | 冻结金额，分 |
| deducted_amount | bigint | 是 | 已扣减金额，分 |
| refundable_amount | bigint | 是 | 可退金额，分 |
| status | enum | 是 | 保证金状态 |

### 15.6 deposit_transaction 保证金流水

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| deposit_account_id | uuid | 是 | 保证金账户 |
| transaction_type | enum | 是 | RECEIVE / FREEZE / UNFREEZE / DEDUCT / REFUND |
| amount | bigint | 是 | 金额，分 |
| related_bill_id | uuid | 否 | 关联账单 |
| related_event_id | uuid | 否 | 关联事件 |
| remark | text | 否 | 备注 |
| operated_by | uuid | 是 | 操作人 |
| operated_at | timestamp | 是 | 操作时间 |

---

## 16. 催收与风险处置表

### 16.1 overdue_record 逾期记录

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| bill_id | uuid | 是 | 账单ID |
| order_id | uuid | 是 | 订单ID |
| customer_id | uuid | 是 | 客户ID |
| overdue_days | int | 是 | 逾期天数 |
| overdue_level | enum | 是 | M1 / M2 / M3 |
| overdue_amount | bigint | 是 | 逾期金额 |
| status | enum | 是 | OPEN / RESOLVED / WRITTEN_OFF |

### 16.2 collection_task 催收任务

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| overdue_record_id | uuid | 是 | 逾期记录 |
| assigned_to | uuid | 是 | 催收人员 |
| task_status | enum | 是 | TODO / PROCESSING / DONE / CLOSED |
| next_action_at | timestamp | 否 | 下次动作时间 |
| result | text | 否 | 结果 |

### 16.3 default_event 违约事件

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| order_id | uuid | 是 | 订单ID |
| customer_id | uuid | 是 | 客户ID |
| event_type | enum | 是 | PAYMENT_DEFAULT / LOST_CONTACT / VEHICLE_LOST / FRAUD / MAJOR_ACCIDENT |
| event_date | date | 是 | 发生日期 |
| loss_amount | bigint | 否 | 预估损失 |
| status | enum | 是 | OPEN / PROCESSING / CLOSED |
| remark | text | 否 | 备注 |

---

## 17. 客户权益表

### 17.1 customer_benefit_account 权益账户

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| order_id | uuid | 是 | 订单ID |
| benefit_type | enum | 是 | CAR_SWAP / WASH / ENERGY / POINTS / OTHER |
| total_quota | int | 是 | 总额度 |
| used_quota | int | 是 | 已用额度 |
| remaining_quota | int | 是 | 剩余额度 |
| valid_from | date | 是 | 生效日 |
| valid_to | date | 是 | 失效日 |
| status | enum | 是 | ACTIVE / EXPIRED / FROZEN |

### 17.2 points_account 积分账户

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| customer_id | uuid | 是 | 客户ID |
| balance | int | 是 | 当前积分 |
| total_earned | int | 是 | 累计获得 |
| total_used | int | 是 | 累计消耗 |

### 17.3 points_transaction 积分流水

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | uuid | 是 | ID |
| points_account_id | uuid | 是 | 积分账户 |
| transaction_type | enum | 是 | EARN / USE / EXPIRE / ADJUST |
| points | int | 是 | 积分 |
| reason | varchar(255) | 是 | 原因 |
| related_order_id | uuid | 否 | 关联订单 |
| operated_at | timestamp | 是 | 操作时间 |

---

## 18. 报表与经营分析表

### 18.1 daily_order_report 订单日报

| 字段 | 类型 | 说明 |
|---|---|---|
| report_date | date | 日期 |
| new_leads_count | int | 新线索 |
| new_applications_count | int | 新进件 |
| approved_applications_count | int | 审批通过 |
| new_orders_count | int | 新订单 |
| active_orders_count | int | 在租订单 |
| terminated_orders_count | int | 终止订单 |

### 18.2 fleet_operation_report 车队运营报表

| 字段 | 类型 | 说明 |
|---|---|---|
| report_date | date | 日期 |
| total_vehicles | int | 车辆总数 |
| available_vehicles | int | 可出租车辆 |
| rented_vehicles | int | 在租车辆 |
| maintenance_vehicles | int | 维修车辆 |
| idle_rate | decimal | 空置率 |
| utilization_rate | decimal | 出租率 |
| avg_turnover_days | decimal | 平均周转天数 |

### 18.3 asset_quality_report 资产质量报表

| 字段 | 类型 | 说明 |
|---|---|---|
| report_date | date | 日期 |
| active_orders_count | int | 在租订单 |
| m1_count | int | M1 |
| m2_count | int | M2 |
| m3_count | int | M3 |
| overdue_amount | bigint | 逾期金额 |
| default_rate | decimal | 违约率 |
| loss_amount | bigint | 损失金额 |

### 18.4 roa_roe_report ROA/ROE 报表

| 字段 | 类型 | 说明 |
|---|---|---|
| report_month | date | 月份 |
| total_asset_amount | bigint | 资产总额 |
| total_equity_amount | bigint | 权益资金 |
| debt_amount | bigint | 债务资金 |
| finance_cost_rate | decimal | 资金成本 |
| operating_profit_amount | bigint | 经营利润 |
| roa | decimal | ROA |
| roe | decimal | ROE |
| leverage_de_ratio | decimal | D/E 杠杆 |

---

## 19. 后端 API 设计

### 19.1 客户接口

```http
GET    /api/customers
POST   /api/customers
GET    /api/customers/:id
PATCH  /api/customers/:id
POST   /api/customers/:id/followups
GET    /api/customers/:id/followups
POST   /api/customers/:id/blacklist
```

### 19.2 进件与风控接口

```http
POST   /api/applications
GET    /api/applications
GET    /api/applications/:id
PATCH  /api/applications/:id
POST   /api/applications/:id/submit
POST   /api/applications/:id/materials
POST   /api/applications/:id/risk-review
POST   /api/applications/:id/approve
POST   /api/applications/:id/reject
POST   /api/applications/:id/need-more-info
```

### 19.3 产品与报价接口

```http
GET    /api/products
POST   /api/products
POST   /api/products/:id/versions
POST   /api/quotes
GET    /api/quotes/:id
POST   /api/quotes/:id/confirm
POST   /api/quotes/:id/cancel
```

### 19.4 订单与合同接口

```http
POST   /api/orders
GET    /api/orders
GET    /api/orders/:id
POST   /api/orders/:id/generate-contract
POST   /api/orders/:id/sign-contract
POST   /api/orders/:id/assign-vehicle
POST   /api/orders/:id/change
POST   /api/orders/:id/terminate
POST   /api/orders/:id/buyout
```

### 19.5 车辆资产接口

```http
GET    /api/vehicles
POST   /api/vehicles
GET    /api/vehicles/:id
PATCH  /api/vehicles/:id
POST   /api/vehicles/:id/inspection
POST   /api/vehicles/:id/prepare
POST   /api/vehicles/:id/insurance
POST   /api/vehicles/:id/maintenance
POST   /api/vehicles/:id/disposal
```

### 19.6 交付与回收接口

```http
POST   /api/deliveries
GET    /api/deliveries
GET    /api/deliveries/:id
POST   /api/deliveries/:id/checklist
POST   /api/deliveries/:id/complete

POST   /api/returns
GET    /api/returns
GET    /api/returns/:id
POST   /api/returns/:id/inspect
POST   /api/returns/:id/settle
```

### 19.7 账务接口

```http
POST   /api/bills/generate
GET    /api/bills
GET    /api/bills/:id
POST   /api/payments
POST   /api/writeoffs
GET    /api/deposits
POST   /api/deposits/:id/freeze
POST   /api/deposits/:id/unfreeze
POST   /api/deposits/:id/deduct
POST   /api/deposits/:id/refund
```

### 19.8 催收接口

```http
GET    /api/overdues
POST   /api/overdues/recalculate
POST   /api/collection-tasks
PATCH  /api/collection-tasks/:id
POST   /api/default-events
```

### 19.9 权益接口

```http
GET    /api/benefits
POST   /api/benefits/grant
POST   /api/benefits/use
GET    /api/points/:customerId
POST   /api/points/earn
POST   /api/points/use
```

### 19.10 报表接口

```http
GET    /api/reports/orders/daily
GET    /api/reports/fleet
GET    /api/reports/asset-quality
GET    /api/reports/revenue
GET    /api/reports/deposit-pool
GET    /api/reports/roa-roe
```

---

## 20. 后台页面设计

### 20.1 菜单结构

```text
首页驾驶舱
客户中心
  - 客户列表
  - 线索池
  - 进件管理
  - 客户跟进
风控中心
  - 待审批进件
  - 风控结果
  - 客户评级规则
  - 黑名单
产品中心
  - 产品列表
  - 产品版本
  - 押金规则
  - 里程包
  - 补能包
  - 权益包
订单中心
  - 订单列表
  - 报价方案
  - 订单变更
  - 合同管理
资产中心
  - 车辆列表
  - 采购入库
  - 整备管理
  - 保险管理
  - 维修保养
  - 车辆退出
交付中心
  - 待交付
  - 交付记录
  - 退车管理
账务中心
  - 账单管理
  - 收款管理
  - 核销管理
  - 保证金池
催收中心
  - 逾期列表
  - 催收任务
  - 违约事件
权益中心
  - 客户权益
  - 积分账户
报表中心
  - 订单日报
  - 资产质量报表
  - 车队运营报表
  - 收入报表
  - ROA/ROE
系统管理
  - 用户管理
  - 角色权限
  - 审批流配置
  - 操作日志
```

### 20.2 首页驾驶舱

展示：

- 总车辆数
- 在租车辆数
- 出租率
- 新增线索
- 新增订单
- 本月收入
- 应收金额
- 逾期金额
- 保证金余额
- ROA
- ROE
- M1/M2/M3
- 待审批事项
- 待交付车辆
- 待退车车辆

---

## 21. 核心业务规则

### 21.1 月费规则

客户平均订阅月费总额不超过车辆实际采购价的 3.5%。

```text
月费上限 = 车辆采购价 × 3.5%
```

系统应在生成报价时自动校验：

```text
monthly_fee_amount <= vehicle_purchase_price_amount * monthly_fee_rate
```

### 21.2 客户等级与押金

客户分为 A/B/C 三档。

| 等级 | 押金 | 违约率 | 说明 |
|---|---:|---:|---|
| A | 可配置 | 可配置 | 优质客户 |
| B | 可配置 | 可配置 | 普通客户 |
| C | 可配置 | 可配置 | 高风险客户 |

报价时：

```text
押金 = deposit_rule[customer_grade].deposit_amount
违约率 = deposit_rule[customer_grade].default_rate
```

### 21.3 车辆交付条件

订单进入交付前必须满足：

- 客户审批通过
- 合同已签署
- 押金已到账
- 首期月费已到账
- 车辆状态为 AVAILABLE 或 RESERVED
- 车辆完成整备
- 车辆保险有效
- 车辆电量达到交付标准
- 交付单已生成

### 21.4 保证金扣减规则

允许扣减场景：

- 未付账单
- 超里程
- 车辆损伤
- 违章未处理
- 合同违约金
- 其他经合同约定的费用

扣减必须生成：

- 扣减申请
- 审批记录
- 保证金流水
- 账务凭证

### 21.5 逾期等级

| 等级 | 天数 |
|---|---|
| M1 | 1–30 天 |
| M2 | 31–60 天 |
| M3 | 61 天及以上 |

---

## 22. 审计日志

### 22.1 audit_log 表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | ID |
| module | varchar | 模块 |
| entity_type | varchar | 实体类型 |
| entity_id | uuid | 实体ID |
| action | varchar | 操作 |
| before_snapshot | jsonb | 操作前 |
| after_snapshot | jsonb | 操作后 |
| operator_id | uuid | 操作人 |
| ip_address | varchar | IP |
| user_agent | varchar | UA |
| created_at | timestamp | 操作时间 |

必须记录的操作：

- 客户资料修改
- 风控审批
- 押金规则修改
- 产品价格修改
- 合同生成、签署、归档
- 订单变更
- 车辆状态变更
- 账单修改
- 收款核销
- 保证金冻结、扣减、退还
- 逾期处置
- 权益调整

---

## 23. 文件管理

### 23.1 file_object 表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 文件ID |
| bucket | varchar | 存储桶 |
| object_key | varchar | 对象路径 |
| original_name | varchar | 原文件名 |
| mime_type | varchar | MIME |
| size_bytes | bigint | 文件大小 |
| uploaded_by | uuid | 上传人 |
| created_at | timestamp | 上传时间 |

文件类型：

- 身份证
- 驾驶证
- 征信授权
- 合同
- 车辆照片
- 检测报告
- 交付照片
- 退车照片
- 维修单
- 保单

---

## 24. 报表指标口径

### 24.1 出租率

```text
出租率 = 在租车辆数 / 可运营车辆数
```

可运营车辆不包含：已出售、报废、长期维修不可用、待采购未入库。

### 24.2 空置率

```text
空置率 = 可出租未出租车辆数 / 可运营车辆数
```

### 24.3 单车 ROA

```text
单车 ROA = 单车年度经营利润 / 单车平均占用资产
```

单车年度经营利润不扣融资成本，融资成本单独用于 ROE 计算。

### 24.4 ROE

```text
ROE = ROA + (ROA - 资金成本) × D/E
```

### 24.5 保证金池余额

```text
保证金池余额 = 已收押金 - 已退还押金 - 已扣减押金
```

---

## 25. 开发阶段拆分

### 阶段 1：基础框架与权限

目标：

- 建立项目框架
- 建立用户、角色、权限
- 建立审计日志
- 建立基础字典枚举

交付物：

- 登录
- 用户管理
- 角色权限
- 菜单权限
- 操作日志

验收标准：

- 不同角色登录后菜单不同
- 所有关键操作写入 audit_log
- 权限不足时返回 403

### 阶段 2：客户与进件

目标：

- 客户列表
- 客户详情
- 进件创建
- 资料上传
- 进件提交

验收标准：

- 销售可创建客户和进件
- 进件资料可上传
- 进件状态可从 DRAFT 变为 SUBMITTED

### 阶段 3：风控与押金规则

目标：

- 客户评级
- 押金规则
- 违约率配置
- 风控审批

验收标准：

- A/B/C 押金可配置
- 审批通过后生成 risk_result
- 报价时可自动读取押金

### 阶段 4：产品与报价

目标：

- 产品管理
- 产品版本
- 价格规则
- 订阅报价

验收标准：

- 月费不超过采购价 3.5%
- 报价可确认
- 报价确认后可生成订单

### 阶段 5：订单与合同

目标：

- 订单创建
- 合同生成
- 合同签署状态
- 订单变更

验收标准：

- 订单从 PENDING_CONTRACT 进入 PENDING_PAYMENT
- 合同文件可归档
- 订单变更需审批

### 阶段 6：车辆资产

目标：

- 车辆入库
- 车辆检测
- 车辆整备
- 保险管理
- 车辆状态流转

验收标准：

- 车辆完成整备后进入 AVAILABLE
- 车辆被分配后进入 RESERVED
- 交付后进入 IN_USE

### 阶段 7：交付与退车

目标：

- 交付单
- 交接记录
- 退车单
- 损伤记录

验收标准：

- 交付必须校验合同、押金、首期月费、车辆状态
- 退车后可生成损伤费用
- 车辆回收后可进入 AVAILABLE / MAINTENANCE / DISPOSAL_PENDING

### 阶段 8：账务与保证金

目标：

- 账单生成
- 收款记录
- 核销
- 保证金账户
- 保证金流水

验收标准：

- 订单交付后生成首期及后续账单计划
- 收款后可核销账单
- 保证金收、冻、扣、退均有流水

### 阶段 9：催收与违约

目标：

- 逾期识别
- 催收任务
- 违约事件
- 车辆失联/回收

验收标准：

- 逾期天数自动计算
- M1/M2/M3 自动分类
- 催收任务可指派和跟进

### 阶段 10：报表驾驶舱

目标：

- 订单日报
- 车队运营报表
- 资产质量报表
- 收入报表
- 保证金池报表
- ROA/ROE 报表

验收标准：

- 首页展示核心指标
- 报表支持日期筛选
- 支持导出 Excel

---

## 26. 验收用测试场景

### 场景 1：完整客户进件到交付

1. 销售创建客户。
2. 上传身份证、驾驶证。
3. 提交进件。
4. 风控审批为 A 级。
5. 系统匹配 A 级押金。
6. 创建报价。
7. 确认报价生成订单。
8. 生成合同。
9. 财务登记押金和首期月费。
10. 分配车辆。
11. 创建交付单。
12. 完成交付。
13. 订单状态变为 ACTIVE，车辆状态变为 IN_USE。

### 场景 2：客户退车并扣减保证金

1. 客户申请退车。
2. 创建退车单。
3. 验车发现损伤。
4. 生成损伤费用。
5. 财务从保证金扣减。
6. 生成 deposit_transaction。
7. 退还剩余保证金。
8. 车辆进入 MAINTENANCE 或 AVAILABLE。

### 场景 3：账单逾期与催收

1. 系统生成月账单。
2. 到期未付款。
3. 每日任务计算逾期天数。
4. 逾期 1 天进入 M1。
5. 创建催收任务。
6. 催收完成后客户付款。
7. 财务核销。
8. 逾期记录关闭。

### 场景 4：订单变更

1. 客户申请换车。
2. 运营创建 order_change。
3. 风控/资产/财务会签。
4. 总经理审批。
5. 原车退回，新车交付。
6. 合同或补充协议归档。

---

## 27. 非功能要求

### 27.1 安全

- 密码加密存储。
- 敏感字段加密或脱敏展示。
- 身份证、手机号、驾驶证号需要权限控制。
- 文件访问必须使用临时签名 URL。
- 所有导出操作记录日志。

### 27.2 性能

- 500 台车规模下，后台列表查询响应小于 1 秒。
- 支持 10 万级账单数据。
- 常用列表必须分页。
- 报表建议使用快照表，不要每次实时全量计算。

### 27.3 可维护性

- 枚举集中定义。
- API 返回格式统一。
- 错误码统一。
- 业务校验写在 service 层。
- 页面组件按模块拆分。
- 表单字段使用统一 schema。

### 27.4 可审计

- 所有审批、财务、车辆状态流转必须可追溯。
- 修改前后值保存到 audit_log。
- 不允许物理删除核心业务数据。

---

## 28. 暂不纳入 V1.0 的功能

以下功能先预留，不在 V1.0 强制实现：

- 用户端 App
- 自动代扣
- 电子签真实接口
- 银行征信直连
- GPS 实时地图
- 自动违章查询
- 自动保险报价
- ABS 资产证券化报送
- AI 客服
- 自动化残值预测

V1.0 先以后台人工操作和数据闭环为主。

---

## 29. 交付标准

V1.0 完成时，应具备：

1. 可登录后台。
2. 可创建客户、进件、审批。
3. 可配置客户等级、押金、违约率。
4. 可配置产品和报价。
5. 可生成订单和合同记录。
6. 可管理车辆资产。
7. 可完成车辆交付。
8. 可生成账单、登记收款、核销。
9. 可管理保证金。
10. 可处理逾期和催收。
11. 可退车、验车、结算。
12. 可查看基础经营报表。
13. 所有关键操作可追溯。
14. 核心流程有测试覆盖。
15. README 写清楚启动和部署方式。

---

## 30. 推荐仓库结构

```text
auto-subscription-platform/
├── AGENTS.md
├── DEV_SPEC.md
├── README.md
├── apps/
│   ├── web/
│   │   ├── src/
│   │   └── package.json
│   └── api/
│       ├── src/
│       ├── prisma/
│       └── package.json
├── packages/
│   ├── shared/
│   │   ├── enums/
│   │   ├── types/
│   │   └── validators/
│   └── ui/
├── docs/
│   ├── business-process.md
│   ├── database-schema.md
│   ├── api-spec.md
│   └── test-cases.md
└── docker-compose.yml
```

---

## 31. Codex 分任务提示词

### Task 1 初始化项目骨架

```text
请基于当前仓库初始化汽车订阅运营中台项目。

要求：
1. 阅读 DEV_SPEC.md。
2. 建立基础项目结构。
3. 如果仓库为空，使用 Next.js + NestJS + PostgreSQL + Prisma 的 monorepo 结构。
4. 创建 apps/web、apps/api、packages/shared。
5. 配置 TypeScript、ESLint、Prettier。
6. 创建基础 README。
7. 不要实现业务功能，只完成项目骨架。
8. 提交代码并说明启动命令和测试命令。
```

### Task 2 用户权限与审计日志

```text
请实现用户、角色、权限、菜单权限和审计日志模块。

参考 DEV_SPEC.md 第 4 章和第 22 章。

要求：
1. 创建 user、role、permission、user_role、role_permission、audit_log 表。
2. 实现登录态或最小可用认证。
3. 后台提供用户管理、角色管理、权限配置页面。
4. 所有关键操作写入 audit_log。
5. 添加基础测试。
6. 不要实现客户业务模块。
```

### Task 3 客户与进件

```text
请实现客户中心和进件管理模块。

参考 DEV_SPEC.md 第 9 章、第 10 章。

要求：
1. 创建 customer、customer_identity、customer_profile、customer_followup、application、application_material 表。
2. 实现客户列表、客户详情、客户创建、进件创建、进件提交、资料上传。
3. 实现进件状态流转：DRAFT → SUBMITTED → NEED_MORE_INFO / APPROVED / REJECTED。
4. 权限：销售可创建，风控可查看进件，管理员全量可见。
5. 添加接口测试和页面最小验证。
```

### Task 4 风控评级和押金规则

```text
请实现风控评级、押金规则和违约率配置。

参考 DEV_SPEC.md 第 10.3、10.4、21.2。

要求：
1. 创建 risk_result、deposit_rule。
2. 支持 A/B/C 客户等级。
3. 每个等级可配置押金金额、客户占比、违约率、生效日期。
4. 风控审批通过后生成 risk_result，并回写 customer.grade。
5. 后台页面支持押金规则增删改查。
6. 添加校验：同一等级同一生效区间不能有多个 ACTIVE 规则。
```

### Task 5 产品与报价

```text
请实现产品中心和报价方案模块。

参考 DEV_SPEC.md 第 11 章和第 21.1 条。

要求：
1. 创建 product、product_version、product_price_rule、subscription_quote。
2. 支持产品版本管理。
3. 车型支持 ET5、ET7、ES6。
4. 月费率默认 3.5%，但可配置。
5. 生成报价时校验：月费 <= 车辆采购价 × 月费率。
6. 报价确认后允许进入订单创建。
```

### Task 6 订单与合同

```text
请实现订阅订单和合同管理模块。

参考 DEV_SPEC.md 第 12 章。

要求：
1. 创建 subscription_order、order_change、contract、contract_version。
2. 实现订单创建、合同生成、合同签署状态、合同归档。
3. 实现订单状态流转：PENDING_CONTRACT → PENDING_PAYMENT → PENDING_VEHICLE → PENDING_DELIVERY → ACTIVE。
4. 订单变更必须创建 order_change 并经过审批。
5. 合同文件先用本地或对象存储模拟。
```

### Task 7 车辆资产

```text
请实现车辆资产管理模块。

参考 DEV_SPEC.md 第 13 章。

要求：
1. 创建 vehicle、vehicle_purchase、vehicle_condition、vehicle_insurance、vehicle_maintenance、vehicle_disposal。
2. 支持车辆采购入库、检测、整备、保险、维修、退出。
3. 车辆状态按 asset_status 枚举流转。
4. 车辆完成整备并保险有效后才可进入 AVAILABLE。
5. 车辆详情页展示采购价、SOH、车况、保险、维修记录。
```

### Task 8 交付和退车

```text
请实现车辆交付与退车模块。

参考 DEV_SPEC.md 第 14 章和第 21.3 条。

要求：
1. 创建 delivery_order、handover_record、return_order、damage_record。
2. 创建交付单时校验订单、合同、收款、车辆状态。
3. 完成交付后，订单状态变为 ACTIVE，车辆状态变为 IN_USE。
4. 退车时记录里程、电量、损伤、费用。
5. 退车完成后，车辆可流转至 AVAILABLE、MAINTENANCE 或 DISPOSAL_PENDING。
```

### Task 9 账务和保证金

```text
请实现账单、收款、核销、保证金池模块。

参考 DEV_SPEC.md 第 15 章和第 21.4 条。

要求：
1. 创建 bill、bill_item、payment、writeoff_record、deposit_account、deposit_transaction。
2. 支持账单生成、收款登记、账单核销。
3. 支持保证金收取、冻结、解冻、扣减、退还。
4. 所有保证金变动必须生成 deposit_transaction。
5. 保证金扣减必须关联账单或违约事件。
```

### Task 10 催收和违约

```text
请实现逾期、催收、违约事件模块。

参考 DEV_SPEC.md 第 16 章和第 21.5 条。

要求：
1. 创建 overdue_record、collection_task、default_event。
2. 每日任务自动计算逾期账单。
3. 按 M1/M2/M3 分类。
4. 支持催收任务创建、指派、跟进、关闭。
5. 支持违约事件登记，包括失联、车辆失联、重大事故、欺诈。
```

### Task 11 权益和积分

```text
请实现客户权益和积分模块。

参考 DEV_SPEC.md 第 17 章。

要求：
1. 创建 customer_benefit_account、points_account、points_transaction。
2. 支持换车权益、洗车权益、补能权益、积分。
3. 支持权益发放、使用、冻结、过期。
4. 支持积分获得、使用、调整、过期。
5. 权益变化必须有流水。
```

### Task 12 报表驾驶舱

```text
请实现经营报表和首页驾驶舱。

参考 DEV_SPEC.md 第 18 章和第 24 章。

要求：
1. 实现订单日报、车队运营报表、资产质量报表、保证金池报表、ROA/ROE 报表。
2. 首页展示核心指标。
3. 报表支持日期筛选。
4. 报表支持导出 Excel。
5. ROE 计算公式：ROE = ROA + (ROA - 资金成本) × D/E。
```

---

## 32. AGENTS.md 建议内容

请将下面内容放入仓库根目录的 `AGENTS.md`：

```markdown
# AGENTS.md

## Project

This repository implements a China mainland EV subscription operation platform.

The business includes:
- customer onboarding
- risk approval
- deposit rules
- vehicle subscription orders
- contracts
- vehicle preparation and delivery
- billing and payment write-off
- deposit pool management
- overdue collection
- customer benefits
- ROA/ROE reports

## Instructions

1. Always read DEV_SPEC.md before modifying business logic.
2. Do not remove existing features unless explicitly requested.
3. Implement features incrementally.
4. Use TypeScript strictly if the stack is TypeScript.
5. All money fields are stored in cents.
6. All important status values must be enums.
7. All critical operations must write audit logs.
8. Do not hardcode business constants if they belong in configuration tables.
9. Write tests for status transitions and financial calculations.
10. After changes, run lint, typecheck, and tests.

## Business Rules

- Monthly subscription fee must not exceed 3.5% of vehicle purchase price unless product settings explicitly change.
- Customers are graded A/B/C.
- Deposit amount and default rate are configured by customer grade.
- Delivery requires signed contract, received deposit, received first monthly fee, valid insurance, and prepared vehicle.
- Deposit deduction must generate a transaction record.
- Order and vehicle status transitions must be auditable.

## Expected Output

When completing a task:
- summarize changed files
- summarize business behavior added
- provide how to test
- list known limitations
```

---

## 33. 下一步建议

建议按以下顺序把文档拆给 Codex：

1. 先让 Codex 建项目骨架。
2. 再让 Codex 建数据库 schema。
3. 再实现客户进件。
4. 再实现风控押金。
5. 再实现订单合同。
6. 再实现车辆资产。
7. 再实现账务保证金。
8. 最后实现报表驾驶舱。

不要让 Codex 一次性实现全部系统。这个项目业务对象多、状态机多、财务逻辑多，应按模块分批推进。
