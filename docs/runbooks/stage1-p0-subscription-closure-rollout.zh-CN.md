# Stage 1 P0 订阅闭环发布核对运行手册

> 本手册只做只读核对，不是发布授权。所有 SQL 段必须逐段原样执行；任一异常计数非零、命令门禁非零或历史停止项存在，立即停止。

## 1. 安全边界与继承停止项

- 仅允许在获批的专用 Local/Staging 数据库运行；禁止 Production、seed、backfill、reset、db push、历史 migration/checksum 修复或数据库历史行改写。
- 不得输出或保存 `DATABASE_URL`、数据库用户名、密码、客户 PII、VIN、车牌、内部审批备注或原始 JSON 快照。
- 原始 SQL 输出不得提交 Git。只发布本手册定义的聚合计数和不可逆 fingerprint；证据存入仓库外受控加密存储并记录 SHA-256 与保留期限。
- 当前继承停止证据必须原样保留：migration checksum mismatch **59**、非空 datasource→schema drift、rolled-back migration **1**、permission/history anomalies，以及 `CLOSED_COST_EVIDENCE_DISPOSITION=UNRESOLVED_STOP`（历史观测 2→当前 0、未保留 identity fingerprint）。
- 上述任一项都使环境 `rollout-ineligible`。当前为 `rollout_action: STOP`；不得将“当前零行”解释为历史阻断已清除。

## 2. 命令门禁

依次执行且保存退出码：

```powershell
pnpm prisma:validate
pnpm prisma:migrate:status
pnpm prisma:migrate:checksum:verify
pnpm stage1:p0-closure:reconcile
```

`validate/status` 不能替代 checksum、drift 或下列 12 个只读 SQL 段。validator 会冻结 SQL、API、权限和 package script inventory，并对实际文本做 mutation test。

依赖域需同时参照 [Stage 1C 周期事实](./stage1c-period-facts-rollout.zh-CN.md)、[Stage 1C 资产运营](./stage1c-asset-operations-rollout.zh-CN.md) 与 [Stage 1C 资产会计](./stage1c-asset-accounting-rollout.zh-CN.md) 的停止条件；本手册不会覆盖它们的结论。

## 3. 独立只读 SQL

### 01 migration catalog

<!-- stage1-p0-reconcile:01-migration-catalog:start -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH catalog AS (
  SELECT migration_name, checksum, finished_at, rolled_back_at
  FROM _prisma_migrations
), expected_stage1_p0(migration_name) AS (
  VALUES
    ('20260821120000_stage1_p0_subscription_closure'),
    ('20260821130000_stage1_p0_subscription_closure_integrity'),
    ('20260821140000_stage1_p0_contract_esign_sources'),
    ('20260821141000_stage1_p0_contract_esign_source_immutability'),
    ('20260821230000_stage1_p0_settlement_chronology'),
    ('20260822010000_stage1_p0_closure_esign_semantics'),
    ('20260822020000_stage1_p0_active_closure_and_service_boundary'),
    ('20260822030000_stage1_p0_return_manifest_esign_durability')
)
SELECT
  COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied_migration_count,
  COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back_migration_count,
  COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed_or_incomplete_migration_count,
  (SELECT COUNT(*) FROM expected_stage1_p0 expected JOIN catalog current USING (migration_name)
   WHERE current.finished_at IS NOT NULL AND current.rolled_back_at IS NULL) AS expected_stage1_p0_applied_count,
  md5(COALESCE(string_agg(migration_name || ':' || checksum, '|' ORDER BY migration_name), '')) AS migration_catalog_fingerprint
FROM catalog;
COMMIT;
```

<!-- stage1-p0-reconcile:01-migration-catalog:end -->

### 02 permission matrix

<!-- stage1-p0-reconcile:02-permission-matrix:start -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_permission(code, module, action) AS (
  VALUES
    ('subscription_closure:view', 'subscription_closure', 'view'),
    ('subscription_closure:prepare', 'subscription_closure', 'prepare'),
    ('subscription_closure:receive', 'subscription_closure', 'receive'),
    ('subscription_closure:inspect', 'subscription_closure', 'inspect'),
    ('subscription_closure:settle', 'subscription_closure', 'settle'),
    ('subscription_recovery:assess', 'subscription_recovery', 'assess'),
    ('subscription_recovery:approve', 'subscription_recovery', 'approve'),
    ('subscription_recovery:execute', 'subscription_recovery', 'execute'),
    ('subscription_early_termination:create', 'subscription_early_termination', 'create'),
    ('subscription_early_termination:execute', 'subscription_early_termination', 'execute')
), expected_grant(role_code, permission_code) AS (
  VALUES
    ('ADMIN','subscription_closure:view'),('ADMIN','subscription_closure:prepare'),('ADMIN','subscription_closure:receive'),('ADMIN','subscription_closure:inspect'),('ADMIN','subscription_closure:settle'),('ADMIN','subscription_recovery:assess'),('ADMIN','subscription_recovery:approve'),('ADMIN','subscription_recovery:execute'),('ADMIN','subscription_early_termination:create'),('ADMIN','subscription_early_termination:execute'),
    ('AS','subscription_closure:view'),('AS','subscription_closure:receive'),('AS','subscription_closure:inspect'),('AS','subscription_recovery:execute'),
    ('CS','subscription_closure:view'),('CS','subscription_closure:prepare'),('CS','subscription_early_termination:create'),
    ('FI','subscription_closure:view'),('FI','subscription_closure:settle'),
    ('GM','subscription_closure:view'),('GM','subscription_recovery:approve'),
    ('OP','subscription_closure:view'),('OP','subscription_closure:prepare'),('OP','subscription_closure:receive'),('OP','subscription_closure:inspect'),('OP','subscription_recovery:assess'),('OP','subscription_recovery:execute'),('OP','subscription_early_termination:create'),('OP','subscription_early_termination:execute'),
    ('RC','subscription_closure:view'),('RC','subscription_recovery:assess'),
    ('SA','subscription_closure:view')
), actual_grant AS (
  SELECT role.code::text AS role_code, permission.code AS permission_code
  FROM role_permission grant_row
  JOIN public."role" role ON role.id = grant_row.role_id
  JOIN permission ON permission.id = grant_row.permission_id
  WHERE grant_row.deleted_at IS NULL
    AND role.code IN ('ADMIN','AS','CS','FI','GM','OP','RC','SA')
    AND permission.code IN (SELECT code FROM expected_permission)
)
SELECT
  (SELECT COUNT(*) FROM expected_permission) AS expected_permission_count,
  (SELECT COUNT(*) FROM expected_grant) AS expected_grant_count,
  (SELECT COUNT(*) FROM expected_permission expected LEFT JOIN permission actual USING (code)
   WHERE actual.id IS NULL OR actual.deleted_at IS NOT NULL OR actual.status <> 'ACTIVE'
      OR actual.module IS DISTINCT FROM expected.module OR actual.action IS DISTINCT FROM expected.action) AS permission_definition_anomaly_count,
  (SELECT COUNT(*) FROM (
     SELECT expected.role_code, expected.permission_code
     FROM expected_grant expected LEFT JOIN actual_grant actual USING (role_code, permission_code)
     WHERE actual.role_code IS NULL
     UNION ALL
     SELECT actual.role_code, actual.permission_code
     FROM actual_grant actual LEFT JOIN expected_grant expected USING (role_code, permission_code)
     WHERE expected.role_code IS NULL
   ) anomaly) AS role_grant_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:02-permission-matrix:end -->

### 03 schema objects and triggers

<!-- stage1-p0-reconcile:03-schema-catalog:start -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH required_relation(name) AS (
  VALUES ('subscription_closure_case'),('subscription_closure_event'),('subscription_closure_document_revision'),
         ('subscription_closure_current_document'),('subscription_closure_settlement_revision'),('subscription_closure_command_receipt')
), required_trigger(name) AS (
  VALUES ('subscription_closure_case_immutable_initiation'),('subscription_closure_event_append_only'),
         ('subscription_closure_document_revision_append_only'),('subscription_closure_settlement_revision_append_only'),
         ('subscription_closure_command_receipt_append_only'),('subscription_closure_current_document_authority'),
         ('subscription_closure_case_authority'),('subscription_closure_settlement_chronology')
), required_index(name) AS (
  VALUES ('subscription_closure_case_order_id_key'),('subscription_closure_document_family_revision_key'),
         ('subscription_closure_command_receipt_source_key')
), required_constraint(name) AS (
  VALUES ('subscription_closure_case_retired_shape_chk')
)
SELECT
  (SELECT COUNT(*) FROM required_relation WHERE to_regclass('public.' || name) IS NULL)
  + (SELECT COUNT(*) FROM required_trigger expected LEFT JOIN pg_trigger actual ON actual.tgname = expected.name AND NOT actual.tgisinternal
     WHERE actual.oid IS NULL OR actual.tgenabled <> 'O')
  + (SELECT COUNT(*) FROM required_index expected LEFT JOIN pg_indexes actual ON actual.schemaname = 'public' AND actual.indexname = expected.name WHERE actual.indexname IS NULL)
  + (SELECT COUNT(*) FROM required_constraint expected LEFT JOIN pg_constraint actual ON actual.conname = expected.name WHERE actual.oid IS NULL OR NOT actual.convalidated)
    AS schema_object_anomaly_count,
  (SELECT COUNT(*) FROM required_relation) AS expected_relation_count,
  (SELECT COUNT(*) FROM required_trigger) AS expected_trigger_count;
COMMIT;
```

<!-- stage1-p0-reconcile:03-schema-catalog:end -->

### 04 case state integrity

<!-- stage1-p0-reconcile:04-case-state-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM (SELECT order_id FROM subscription_closure_case WHERE retired_at IS NULL GROUP BY order_id HAVING COUNT(*) > 1) duplicate_active) AS multiple_active_case_count,
  (SELECT COUNT(*) FROM subscription_closure_case
   WHERE (retired_at IS NULL) <> (retired_by IS NULL)
      OR (retired_at IS NOT NULL AND (closure_type <> 'EARLY_TERMINATION' OR status <> 'CANCELLED'
          OR vehicle_return_id IS NOT NULL OR return_asset_work_order_id IS NOT NULL OR recovery_asset_work_order_id IS NOT NULL
          OR reconditioning_asset_work_order_id IS NOT NULL OR physical_controlled_at IS NOT NULL
          OR current_settlement_revision_id IS NOT NULL OR settled_at IS NOT NULL))) AS retired_case_shape_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN subscription_closure_settlement_revision settlement ON settlement.id = closure_case.current_settlement_revision_id
   WHERE closure_case.status IN ('COMPLETED','TERMINATED')
     AND (settlement.id IS NULL OR settlement.closure_case_id <> closure_case.id OR settlement.stage <> 'SETTLED'
          OR settlement.settlement_type <> 'FINAL' OR closure_case.settled_at IS NULL OR closure_case.closed_at IS NULL)) AS terminal_settlement_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN subscription_order order_row ON order_row.id = closure_case.order_id
   LEFT JOIN contract contract_row ON contract_row.id = closure_case.contract_id
   WHERE order_row.id IS NULL OR order_row.vehicle_id IS DISTINCT FROM closure_case.vehicle_id
      OR order_row.customer_id IS DISTINCT FROM closure_case.customer_id OR order_row.contract_id IS DISTINCT FROM closure_case.contract_id
      OR contract_row.id IS NULL OR contract_row.order_id IS DISTINCT FROM closure_case.order_id
      OR contract_row.customer_id IS DISTINCT FROM closure_case.customer_id) AS authority_projection_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:04-case-state-integrity:end -->

### 05 source receipts

<!-- stage1-p0-reconcile:05-source-receipt-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM subscription_closure_command_receipt receipt
   LEFT JOIN subscription_closure_event event ON event.id = receipt.event_id
   WHERE event.id IS NULL OR event.closure_case_id IS DISTINCT FROM receipt.closure_case_id
      OR event.actor_id IS DISTINCT FROM receipt.actor_id OR event.source_type IS DISTINCT FROM receipt.source_type
      OR event.source_id IS DISTINCT FROM receipt.source_id OR event.source_key IS DISTINCT FROM receipt.source_key) AS receipt_event_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_event event
   LEFT JOIN subscription_closure_command_receipt receipt ON receipt.event_id = event.id
   WHERE receipt.id IS NULL) AS event_without_receipt_count,
  (SELECT COUNT(*) FROM subscription_closure_command_receipt
   WHERE payload_hash !~ '^[0-9a-f]{64}$' OR btrim(source_type) = '' OR btrim(source_key) = '') AS payload_hash_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:05-source-receipt-integrity:end -->

### 06 physical control and occupancy

<!-- stage1-p0-reconcile:06-physical-occupancy-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN vehicle_return return_row ON return_row.id = closure_case.vehicle_return_id
   WHERE closure_case.physical_controlled_at IS NOT NULL
     AND (return_row.id IS NULL OR return_row.order_id <> closure_case.order_id OR return_row.vehicle_id <> closure_case.vehicle_id
          OR return_row.customer_id <> closure_case.customer_id OR return_row.return_status <> 'CONFIRMED' OR return_row.returned_at IS NULL)) AS physical_return_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN LATERAL (SELECT period.* FROM vehicle_subscription_period period
     WHERE period.order_id = closure_case.order_id ORDER BY period.started_at DESC, period.id DESC LIMIT 1) period ON true
   WHERE closure_case.physical_controlled_at IS NOT NULL
     AND (period.id IS NULL OR period.vehicle_id <> closure_case.vehicle_id OR period.customer_id <> closure_case.customer_id
          OR period.ended_at IS NULL OR period.end_source_id IS DISTINCT FROM closure_case.id)) AS subscription_period_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   JOIN vehicle_subscription_period period ON period.order_id = closure_case.order_id AND period.ended_at IS NULL
   WHERE closure_case.physical_controlled_at IS NOT NULL) AS active_period_after_physical_control_count;
COMMIT;
```

<!-- stage1-p0-reconcile:06-physical-occupancy-integrity:end -->

### 07 work-order and restriction links

<!-- stage1-p0-reconcile:07-work-order-restriction-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH expected_work_order AS (
  SELECT id AS closure_case_id, order_id, vehicle_id, customer_id, contract_id, return_asset_work_order_id AS work_order_id, 'RETURN_INBOUND'::text AS expected_type FROM subscription_closure_case
  UNION ALL SELECT id, order_id, vehicle_id, customer_id, contract_id, recovery_asset_work_order_id, 'RECOVERY' FROM subscription_closure_case
  UNION ALL SELECT id, order_id, vehicle_id, customer_id, contract_id, reconditioning_asset_work_order_id, 'RECONDITIONING' FROM subscription_closure_case
), work_order_anomaly AS (
  SELECT expected.closure_case_id
  FROM expected_work_order expected LEFT JOIN asset_work_order work_order ON work_order.id = expected.work_order_id
  WHERE expected.work_order_id IS NOT NULL
    AND (work_order.id IS NULL OR work_order.work_order_type::text <> expected.expected_type
      OR work_order.order_id IS DISTINCT FROM expected.order_id OR work_order.vehicle_id IS DISTINCT FROM expected.vehicle_id
      OR work_order.customer_id IS DISTINCT FROM expected.customer_id OR work_order.contract_id IS DISTINCT FROM expected.contract_id)
)
SELECT
  (SELECT COUNT(*) FROM work_order_anomaly) AS work_order_authority_anomaly_count,
  (SELECT COUNT(*) FROM vehicle_operational_restriction restriction
   JOIN asset_work_order work_order ON work_order.id = restriction.work_order_id
   LEFT JOIN subscription_closure_case closure_case ON work_order.id IN (closure_case.return_asset_work_order_id, closure_case.recovery_asset_work_order_id, closure_case.reconditioning_asset_work_order_id)
   WHERE closure_case.id IS NOT NULL AND restriction.vehicle_id <> closure_case.vehicle_id) AS restriction_link_anomaly_count,
  (SELECT COUNT(*) FROM vehicle_operational_restriction restriction
   LEFT JOIN subscription_closure_case closure_case ON closure_case.id = restriction.start_source_id
   WHERE restriction.start_source_type = 'SUBSCRIPTION_CLOSURE' AND closure_case.id IS NULL) AS restriction_source_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:07-work-order-restriction-integrity:end -->

### 08 settlement revisions and financial resolution

<!-- stage1-p0-reconcile:08-settlement-financial-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
WITH ordered AS (
  SELECT revision.*, lag(id) OVER (PARTITION BY closure_case_id ORDER BY revision_number) AS prior_id
  FROM subscription_closure_settlement_revision revision
)
SELECT
  (SELECT COUNT(*) FROM ordered
   WHERE (revision_number = 1 AND supersedes_revision_id IS NOT NULL)
      OR (revision_number > 1 AND supersedes_revision_id IS DISTINCT FROM prior_id)
      OR input_snapshot_hash !~ '^[0-9a-f]{64}$' OR result_hash !~ '^[0-9a-f]{64}$') AS settlement_chain_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN subscription_closure_settlement_revision settlement ON settlement.id = closure_case.current_settlement_revision_id
   WHERE closure_case.status IN ('COMPLETED','TERMINATED')
     AND (settlement.id IS NULL OR settlement.stage <> 'SETTLED' OR settlement.settlement_type <> 'FINAL'
       OR COALESCE((settlement.result_snapshot->>'obligationsResolved')::boolean, false) IS NOT TRUE)) AS terminal_financial_resolution_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_settlement_revision settlement
   LEFT JOIN business_exception_approval waiver ON waiver.id = settlement.waiver_approval_id
   LEFT JOIN business_exception_approval write_off ON write_off.id = settlement.write_off_approval_id
   WHERE (settlement.waiver_approval_id IS NOT NULL AND (waiver.id IS NULL OR waiver.exception_type <> 'SETTLEMENT_WAIVER' OR waiver.subject_id <> settlement.closure_case_id))
      OR (settlement.write_off_approval_id IS NOT NULL AND (write_off.id IS NULL OR write_off.exception_type <> 'SETTLEMENT_WRITE_OFF' OR write_off.subject_id <> settlement.closure_case_id))) AS approval_link_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:08-settlement-financial-integrity:end -->

### 09 approval snapshots

<!-- stage1-p0-reconcile:09-approval-snapshot-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM business_exception_approval approval
   LEFT JOIN subscription_closure_case closure_case ON closure_case.id = approval.subject_id
   WHERE approval.subject_type IN ('RECOVERY_CASE','SETTLEMENT_CASE') AND closure_case.id IS NULL) AS approval_subject_anomaly_count,
  (SELECT COUNT(*) FROM business_exception_approval
   WHERE subject_type IN ('RECOVERY_CASE','SETTLEMENT_CASE')
     AND ((status IN ('APPROVED','REJECTED') AND (decided_by IS NULL OR decided_at IS NULL OR decided_by = requested_by))
       OR (status = 'EXPIRED' AND (expired_by IS NULL OR expired_at IS NULL)))) AS approval_actor_anomaly_count,
  (SELECT COUNT(*) FROM business_exception_approval
   WHERE subject_type IN ('RECOVERY_CASE','SETTLEMENT_CASE')
     AND (subject_snapshot_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(subject_snapshot) <> 'object')) AS approval_hash_shape_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:09-approval-snapshot-integrity:end -->

### 10 order/contract/lease projections

<!-- stage1-p0-reconcile:10-projection-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN subscription_order order_row ON order_row.id = closure_case.order_id
   LEFT JOIN contract contract_row ON contract_row.id = closure_case.contract_id
   LEFT JOIN lease lease_row ON lease_row.order_id = closure_case.order_id
   WHERE (closure_case.status = 'COMPLETED' AND (order_row.order_status <> 'COMPLETED' OR contract_row.status <> 'COMPLETED' OR lease_row.status <> 'COMPLETED'))
      OR (closure_case.status = 'TERMINATED' AND (order_row.order_status <> 'TERMINATED' OR contract_row.status <> 'TERMINATED' OR lease_row.status <> 'COMPLETED'))) AS order_contract_lease_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   LEFT JOIN subscription_order order_row ON order_row.id = closure_case.order_id
   LEFT JOIN contract contract_row ON contract_row.id = closure_case.contract_id
   LEFT JOIN lease lease_row ON lease_row.order_id = closure_case.order_id
   WHERE closure_case.status IN ('RETURN_INSPECTION','RECONDITIONING','PENDING_SETTLEMENT')
     AND (order_row.order_status <> 'RETURNED_PENDING_SETTLEMENT' OR lease_row.status <> 'COMPLETED'
       OR contract_row.status NOT IN ('SIGNED','ARCHIVED'))) AS pre_settlement_projection_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:10-projection-integrity:end -->

### 11 audit integrity

<!-- stage1-p0-reconcile:11-audit-integrity:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM (
     SELECT event.id
     FROM subscription_closure_event event
     LEFT JOIN audit_log audit ON audit.entity_id = event.id AND audit.entity_type = 'subscription_closure_event' AND audit.module = 'subscription_closure'
     GROUP BY event.id HAVING COUNT(audit.id) <> 1
   ) anomaly) AS event_audit_anomaly_count,
  (SELECT COUNT(*) FROM subscription_closure_case closure_case
   WHERE closure_case.status IN ('COMPLETED','TERMINATED')
     AND (NOT EXISTS (SELECT 1 FROM audit_log audit WHERE audit.entity_id = closure_case.order_id AND audit.entity_type = 'subscription_order' AND audit.module = 'subscription_closure')
       OR NOT EXISTS (SELECT 1 FROM audit_log audit WHERE audit.entity_id = closure_case.contract_id AND audit.entity_type = 'contract' AND audit.module = 'subscription_closure'))) AS terminal_projection_audit_anomaly_count;
COMMIT;
```

<!-- stage1-p0-reconcile:11-audit-integrity:end -->

### 12 fixture residue and sessions

<!-- stage1-p0-reconcile:12-fixture-residue:start -->

```sql
BEGIN TRANSACTION READ ONLY;
SELECT
  (SELECT COUNT(*) FROM subscription_closure_command_receipt
   WHERE source_key LIKE 'task-%' OR source_key LIKE 'expiry-integration:%' OR source_type LIKE 'TASK%')
  + (SELECT COUNT(*) FROM subscription_closure_event
     WHERE source_key LIKE 'task-%' OR source_key LIKE 'expiry-integration:%' OR source_type LIKE 'TASK%') AS fixture_source_residue_count,
  (SELECT COUNT(*) FROM subscription_automation_job
   WHERE idempotency_key LIKE 'expiry-integration:%' OR idempotency_key LIKE 'task-%') AS fixture_job_residue_count,
  (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle') AS other_nonidle_session_count,
  (SELECT COUNT(*) FROM pg_locks WHERE NOT granted) AS waiting_lock_count,
  (SELECT COUNT(*) FROM pg_prepared_xacts) AS prepared_transaction_count;
COMMIT;
```

<!-- stage1-p0-reconcile:12-fixture-residue:end -->

## 4. 结果判定和脱敏发布

- 每段必须返回且只返回一行聚合计数；validator 的公开 diagnostic 仅包含段名、行数和字段数，不包含 ID、PII、快照或连接信息。
- 完整原始结果只进入仓库外受控加密证据存储；对原始证据和脱敏摘要分别计算 SHA-256。
- anomaly/residue/session/lock/prepared 计数任一非零均停止；migration 段的 rolled-back 非零同样停止。
- 即使 12 段均为零，也必须继续执行独立 checksum 与 datasource→schema drift 门禁。当前继承 59 mismatch、非空 drift、rolled-back 1 和历史 unresolved stop，因此结论仍为 `rollout-ineligible` / `STOP`。

## 5. 恢复与再次核对

- 发现异常时只记录类别、脱敏计数、受控证据引用和责任人；不得现场 UPDATE/DELETE、覆盖 checksum 或修改历史 migration。
- 由单独批准的修复计划完成根因处理后，从命令门禁开始重新执行全部 12 段并重新计算证据 SHA-256。
- 本手册不授权部署、迁移 apply、数据修复或 Production 变更。
