# 月度里程复核 Staging 验收手册

## 目标与边界

本手册验证车辆交付里程基线、月度里程复核、里程包核销、独立超里程账单、下一周期生成和受控作废重开。固定月租账单与里程复核相互独立：客户未提交、逾期、被退回或等待审核时，均不得阻止下一期 `MONTHLY_RENT` 账单生成。

仅使用合成客户、合成车辆和合成订单。不得修改真实客户的车辆里程、权益或账单。

## 发布前检查

1. 部署包含下列迁移的 API 镜像：
   - `20260802100000_vehicle_mileage_readings`
   - `20260802130000_monthly_mileage_reviews`
2. 执行 `pnpm prisma:migrate:deploy`，确认迁移状态无待执行项。
3. Staging 配置：
   - `MILEAGE_REVIEW_WORKER_ENABLED=true`
   - `MILEAGE_REVIEW_WORKER_POLL_INTERVAL_MS=60000`
   - `WECHAT_TEMPLATE_MILEAGE_REVIEW_DUE` 按已批准模板配置；未配置时仍应生成站内通知，外部通知失败不得回滚复核状态。
4. 执行种子同步，确认管理员角色具备里程复核、车辆里程档案的查看与操作权限。
5. 记录本次镜像 tag、迁移版本、验收人员、合成订单号和开始时间。

## 场景 A：交付里程基线

1. 创建合成车辆，可在新建时填写初始化里程。
2. 将合成订单推进至 Stage 2 签署完成。
3. 打开“确认交付”：
   - 默认交付时间应等于 Stage 2 双方签署完成时间；
   - 默认交付里程应等于 Field 交接单现场里程；
   - 两项均允许修改，并清晰标记人工调整。
4. 确认交付后检查：
   - 订单为已交付/生效状态；
   - 车辆表 `current_mileage_km` 等于最终交付里程；
   - 新增一条 `DELIVERY_BASELINE` 且为 `ACTIVE` 的不可变里程记录；
   - 第 1 期复核按实际交付日的月度周期创建；
   - 车辆残值重算标记已更新。

保存确认弹窗、车辆里程时间线和数据库记录截图。

## 场景 B：客户提交与管理员确认

1. 将第 1 期 `scheduled_review_at` 推进到当前时间，运行一次里程复核 worker。
2. 确认状态从 `SCHEDULED` 变为 `PENDING_SUBMISSION`，Portal“我的申请/我的订单”持续提供里程复核入口。
3. 客户上传至少一张里程表照片，填写累计里程和拍摄时间并提交。
4. 管理员在里程复核工作台确认：
   - 基线、实际用量、月度额度、核销量、超里程量和费率正确；
   - 确认后生成一条 `MONTHLY_REVIEW` 里程记录；
   - 车辆 `current_mileage_km` 与该记录一致；
   - 里程权益用量仅核销本周期额度，未用额度到期不结转；
   - 仅在超里程大于 0 时生成一张 `OVER_MILEAGE` 独立账单；
   - 超里程账单到期日为确认时间后 5 个自然日；
   - 第 2 期复核自动创建。
5. 用相同幂等键重复确认，不得重复生成里程记录、权益用量或账单。

保存 Portal 提交页、管理员计算结果、权益记录、车辆里程时间线、超里程账单和下一周期截图。

## 场景 C：客户怠于确认不阻塞月租

1. 准备四个合成订单，当前复核分别保持：
   - `PENDING_SUBMISSION`；
   - 已超过 `due_at` 的 `PENDING_SUBMISSION`；
   - `RETURNED`；
   - `PENDING_REVIEW`。
2. 将四个订单的账单计划推进到下一固定月租生成时间，运行账单 reconciliation/generation。
3. 对每个订单确认：
   - 恰好生成一张对应周期的 `MONTHLY_RENT`；
   - 重复运行 worker 后仍只有一张；
   - 里程复核状态未被账单 worker 改写；
   - Portal 同时存在待付月租和待提交里程时，下一步优先显示支付账单；
   - 后续确认里程时，超里程费用另行生成 `OVER_MILEAGE`，不并入或重写固定月租。

## 场景 D：后台补录与受控作废重开

1. 由管理员为 `PENDING_SUBMISSION` 复核填写里程、时间并关联本人上传的私有图片，提交后确认。
2. 对最新一期、超里程账单尚未支付的已确认复核执行“作废并重开”：
   - 原复核变为 `VOIDED`；
   - 原权益用量变为 `CANCELLED`，额度恢复；
   - 原超里程账单变为 `CANCELLED`，应付余额归零；
   - 原月度里程记录变为 `VOIDED`；
   - 车辆当前里程恢复到上一条有效记录；
   - 后续未确认周期软删除；
   - 同周期创建版本 `n+1` 的 `PENDING_SUBMISSION` 复核。
3. 验证存在后续已确认周期，或原超里程账单已支付/部分支付时，系统拒绝作废。

## 通知与可观测性

1. 到期激活后应生成确定性通知键：`mileage-review:{reviewId}:{event}:{localDate}`。
2. 同一天重复轮询不得重复发送。
3. 外部短信/微信失败时：
   - 复核激活状态保持成功；
   - 失败原因可观察；
   - 后续轮询可重试；
   - Portal 站内入口仍可用。

## 数据一致性 SQL

以下查询在发布后和验收结束后均应返回 0 行。

### 车辆投影必须等于最新有效里程

```sql
SELECT v.id, v.vehicle_no, v.current_mileage_km, latest.mileage_km
FROM vehicle v
LEFT JOIN LATERAL (
  SELECT r.mileage_km
  FROM vehicle_mileage_reading r
  WHERE r.vehicle_id = v.id AND r.status = 'ACTIVE'
  ORDER BY r.recorded_at DESC, r.created_at DESC
  LIMIT 1
) latest ON TRUE
WHERE v.deleted_at IS NULL
  AND (latest.mileage_km IS NULL OR latest.mileage_km <> v.current_mileage_km);
```

### 已确认复核必须关联有效月度里程

```sql
SELECT mr.id, mr.order_id, mr.cycle_no, mr.version
FROM order_mileage_review mr
LEFT JOIN vehicle_mileage_reading r ON r.id = mr.mileage_reading_id
WHERE mr.deleted_at IS NULL
  AND mr.status = 'CONFIRMED'
  AND (r.id IS NULL OR r.status <> 'ACTIVE' OR r.source_type <> 'MONTHLY_REVIEW');
```

### 超里程账单必须一一对应

```sql
SELECT mr.id, mr.over_mileage_km, mr.over_mileage_amount, COUNT(b.id) AS active_bill_count
FROM order_mileage_review mr
LEFT JOIN receivable_bill b
  ON b.source_key = 'over-mileage:' || mr.id || ':v' || mr.version
 AND b.deleted_at IS NULL
 AND b.bill_status <> 'CANCELLED'
WHERE mr.deleted_at IS NULL AND mr.status = 'CONFIRMED'
GROUP BY mr.id, mr.over_mileage_km, mr.over_mileage_amount
HAVING (mr.over_mileage_amount > 0 AND COUNT(b.id) <> 1)
    OR (mr.over_mileage_amount = 0 AND COUNT(b.id) <> 0);
```

### 每个有效订单周期最多一个非作废版本

```sql
SELECT mr.order_id, mr.cycle_no, COUNT(*) AS active_version_count
FROM order_mileage_review mr
JOIN subscription_order o ON o.id = mr.order_id
WHERE mr.deleted_at IS NULL
  AND mr.status <> 'VOIDED'
  AND o.deleted_at IS NULL
  AND o.order_status = 'ACTIVE'
GROUP BY mr.order_id, mr.cycle_no
HAVING COUNT(*) > 1;
```

## 验收记录

记录以下证据后方可通过：镜像 tag、订单号、车辆号、交付基线、周期边界、客户图片、复核前后权益、月度里程记录、车辆投影、固定月租账单、独立超里程账单及到期日、下一周期、通知事件、作废保护结果和四项一致性 SQL 输出。
