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