# Golden Path Journey 审计 UUID 热修设计

## 背景

staging 申请 `APP20260811071250MC2M` 已完成人工进件审核，但其订阅 Journey 仍停留在
`APPLICATION_VALIDATION / EXCEPTION`。管理员点击“重试失败步骤”时，API 返回
`Internal server error`。

线上日志确认，重试事务在写入 `AuditLog` 时失败：

- `SubscriptionJourney.id` 使用 CUID，例如 `cmsobpjav000001p19v68hers`；
- `AuditLog.entityId` 使用 PostgreSQL UUID；
- `writeAdminAudit` 将 `journey.id` 直接写入 `AuditLog.entityId`；
- PostgreSQL 返回 `22P02`，Prisma 返回 `P2007`，整个事务回滚。

该问题影响所有调用 `writeAdminAudit` 的 Journey 管理操作，包括最终方案决策、最终车辆分配、
交付证据决策、暂停、恢复、异常重试和取消。

## 目标

在不修改全局审计表结构的前提下，使 Journey 管理操作能够写入合法、可关联的审计记录，解除
当前 Golden Path 人工恢复阻塞。

## 设计决策

采用已确认的方案 A：

- `AuditLog.entityId` 写入 `journey.applicationId`。`Application.id` 是 UUID，符合数据库约束；
- `AuditLog.entityType` 继续使用 `subscription_journey`；
- `afterSnapshot` 同时记录 `journeyId`、`applicationId`、操作名称和版本；
- `beforeSnapshot` 保留当前步骤、Journey 状态和版本；
- 不改变 `SubscriptionJourney.id`，不修改 `AuditLog.entityId` 类型。

`applicationId` 是 Journey 的唯一父聚合键，并且 `SubscriptionJourney.applicationId` 存在唯一约束，
因此它可作为 UUID 审计索引键。真正的 Journey CUID 仍保存在快照中，审计时不会丢失 Journey
身份。

## 数据流

修复前：

```text
管理员重试 Journey
  -> 更新失败任务、异常、步骤和 Journey 状态
  -> 写 Journey 领域事件
  -> 写 AuditLog(entityId = journey.id CUID)
  -> UUID 类型错误
  -> 整个事务回滚
```

修复后：

```text
管理员重试 Journey
  -> 更新失败任务、异常、步骤和 Journey 状态
  -> 写 Journey 领域事件
  -> 写 AuditLog(entityId = applicationId UUID,
                  afterSnapshot.journeyId = journey.id CUID)
  -> 事务提交
  -> Worker 领取 RETRY_SCHEDULED 任务
```

## 错误与事务边界

- 审计日志仍与 Journey 管理操作处于同一数据库事务中；不降低关键操作必须审计的要求。
- 不捕获或忽略审计写入失败；其他审计错误仍应使管理事务失败。
- 本热修只消除已确认的 CUID/UUID 类型不兼容，不改变 Journey 业务校验、并发版本校验或幂等键。
- 当前 staging Journey 在热修部署前保持原 `EXCEPTION` 状态，不通过直接数据库更新绕过审计。

## 测试设计

在现有 Journey recovery 测试中增加回归覆盖：

1. 构造 CUID 格式的 Journey ID 和 UUID 格式的 Application ID；
2. 调用 `retryJourney`；
3. 断言 `AuditService.write` 的 `entityId` 等于 `applicationId`，不是 `journeyId`；
4. 断言 `afterSnapshot` 同时包含 `journeyId` 和 `applicationId`；
5. 保留现有任务改为 `RETRY_SCHEDULED`、异常被解决、步骤和 Journey 状态更新断言；
6. 所有 Journey 管理操作继续复用同一个 `writeAdminAudit`；不为每个调用点复制相同测试，现有管理
   操作测试负责保证它们仍调用该共享审计方法。

完成后运行：

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey-recovery.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm -r lint
pnpm prisma:validate
pnpm --filter @subscription-saas/api test
```

## 发布与现有 Journey 恢复

1. 构建并部署新的 staging API 镜像；Web 镜像无需变化。
2. 确认 API 健康且 migration 仍为 up to date；本热修不新增 migration。
3. 管理员刷新申请详情，再次点击“重试失败步骤”。
4. 验证重试接口返回成功，Journey 进入 `RETRY_SCHEDULED`，随后由 Worker 推进。
5. 验证 `APPLICATION_VALIDATION` 完成并进入 `FINAL_PLAN_DECISION / WAITING_MANUAL`。
6. 查询审计记录，确认 `entityId` 为申请 UUID，快照中包含 Journey CUID。

## 非目标

本热修不包含：

- 将 `AuditLog.entityId` 从 UUID 迁移为文本；
- 修改全系统其他审计记录结构；
- 通过直接数据库写入手工推进当前 Journey；
- 调整进件待审核时 Journey 的等待/自动唤醒模型；
- 清理当前 Journey 已有的历史异常记录；
- 修改法大大实名认证或合同签署节点。

进件待审核应进入正常等待状态的最小调整仍是独立后续任务，不与本次审计热修混合。

## 验收标准

- 点击“重试失败步骤”不再返回 `Internal server error`；
- 重试事务产生完整审计记录；
- 审计记录的 `entityId` 是合法的 Application UUID；
- 审计快照可追溯到 Journey CUID；
- Journey 能从当前异常进入重试并继续到最终方案决策；
- 无 Prisma schema 或 migration 变更；
- Journey recovery 相关测试及 API 质量门禁通过。
