# Golden Path 最终方案重新确认期间车辆软锁修复设计

## 1. 背景与根因

Staging 进件 `APP20260811071250MC2M` 在客户确认第 2 版最终方案后，于“创建订单与合同”步骤两次进入异常，错误码为 `JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE`。

数据库证据显示：

- `finalPlanRevision = 2`，`customerConfirmedPlanRevision = 2`，最终方案确认本身有效；
- “分配最终车辆”步骤已完成，随后状态机返回客户重新确认；
- 重新确认分支释放了车辆 `REVIEW_RESERVED` 软锁，清空了 `softReservedVehicleId`，并将 `vehicleReviewStatus` 退回 `PENDING`；
- 客户确认后，状态机按既有设计跳过已经完成的车辆分配步骤，直接创建订单，因此订单创建必然找不到已软锁的最终车辆。

根因位于 `CustomerService.allocateJourneyVehicle()` 的商业方案变化分支：系统已经完成最终车辆分配，却把分配结果与库存占用一并撤销。

## 2. 目标

1. 管理员完成最终车辆分配后，即使车辆商业参数变化并生成新版最终方案，已分配车辆仍保持软锁。
2. 客户只需确认新版最终方案，不再重复进入人工车辆分配步骤。
3. 客户确认后，“创建订单与合同”可将同一车辆从 `REVIEW_RESERVED` 原子转换为 `RESERVED`。
4. 修复当前 Staging 验收进件，使其可以在不要求客户第三次确认的前提下继续重试。

## 3. 不在本轮范围

- 不改变 Journey 步骤顺序和状态机枚举。
- 不改变 Portal 或 Admin 页面结构、接口请求格式及操作按钮。
- 不修改最终方案商业参数比较规则。
- 不新增数据库字段、枚举或迁移。
- 不为任意异常进件增加订单阶段“自动抢车”逻辑。

## 4. 选定方案

采用方案 A：车辆分配是已完成的人工决定，商业方案重新确认只回退客户确认，不撤销车辆分配。

### 4.1 同一车辆已被当前进件软锁

当目标车辆等于 `softReservedVehicleId` 且车辆状态为 `REVIEW_RESERVED`：

- 保持车辆状态不变；
- 保持 `softReservedVehicleId`、`softReservedAt` 和既有软锁期限；
- 将 `vehicleReviewStatus` 保持为 `APPROVED`；
- 仅增加 `finalPlanRevision`，清空本版客户确认字段，并将 `planConfirmStatus` 设为 `PENDING`。

### 4.2 管理员改为另一辆可用车辆

当目标车辆与原软锁车辆不同：

1. 在同一个数据库事务中释放旧车辆软锁；
2. 仅在目标车辆仍为 `AVAILABLE` 时将其更新为 `REVIEW_RESERVED`；
3. 将进件 `softReservedVehicleId` 更新为目标车辆，并记录新的 `softReservedAt`；
4. 保持 `vehicleReviewStatus = APPROVED`；
5. 返回客户确认新版商业方案。

如果目标车辆已不可用，整个事务回滚，旧车辆软锁不丢失，并继续返回既有 `JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE` 错误。

### 4.3 客户重新确认后的推进

客户确认精确的新版修订号后：

- `CUSTOMER_PLAN_CONFIRMATION` 完成；
- 状态机识别 `FINAL_VEHICLE_ALLOCATION` 已完成并跳过它；
- `ORDER_AND_CONTRACT_CREATION` 校验最终车辆仍由本进件以 `REVIEW_RESERVED` 持有；
- 创建订单时将车辆更新为 `RESERVED`，然后创建报价、订单、主合同及初始权益。

## 5. 当前 Staging 验收数据恢复

代码部署后，对 `APP20260811071250MC2M` 执行一次受控事务恢复。事务执行前必须同时满足：

- Journey 当前处于 `ORDER_AND_CONTRACT_CREATION / EXCEPTION`；
- `order_id` 为空；
- `planConfirmStatus = CONFIRMED`；
- `customerConfirmedPlanRevision = finalPlanRevision = 2`；
- `finalVehicleId = 3f04c8a9-f485-4830-b5d9-c91b29ad7ff9`；
- 最终车辆状态仍为 `AVAILABLE`；
- 该车辆没有有效订单，也没有其他进件软锁。

满足全部条件后，在同一事务中：

1. 将最终车辆更新为 `REVIEW_RESERVED`；
2. 恢复进件的 `softReservedVehicleId`、`softReservedAt`，并将 `vehicleReviewStatus` 更新为 `APPROVED`；
3. 写入一条 `ApplicationActionLog`，说明这是 Golden Path 重新确认软锁缺失的数据修复；
4. 再次读取并核对车辆、进件和有效订单占用状态后提交事务。

数据修复不自动重试 Journey。事务完成后，由管理员在页面点击“重试失败步骤”，便于保留可见、可控的验收动作。

任何前置条件不满足时必须整笔拒绝，不覆盖现有业务状态。

## 6. 测试设计

在 `apps/api/test/application-review-api.spec.ts` 增加回归测试：

1. 同一已软锁车辆的商业参数变化触发重新确认时，车辆仍为 `REVIEW_RESERVED`，进件仍指向该车辆，车辆审核仍为 `APPROVED`。
2. 切换至另一辆 `AVAILABLE` 车辆且商业参数变化时，软锁在事务内转移到新车辆，并返回重新确认。
3. 新目标车辆不可用时返回既有错误，且不得留下部分状态更新。

继续运行 Journey 应用、订单合同创建及恢复相关测试，确保客户确认后能够进入订单创建，并且非商业参数变化路径不回归。

## 7. 验收标准

- 客户确认新版最终方案后，Portal 不再显示“需要协助流程受阻”。
- Admin Journey 不再因软锁被清空而在“创建订单与合同”报车辆不可用。
- 创建订单成功后，Journey 进入法大大签署步骤，车辆状态为 `RESERVED`。
- 当前验收进件只需执行一次后台“重试失败步骤”，不要求客户再次确认最终方案。
- Prisma Schema 无变更，迁移数量不变。
