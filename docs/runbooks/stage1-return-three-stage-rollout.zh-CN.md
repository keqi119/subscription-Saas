# 阶段 1 退车三阶段闭环发布手册

该能力替换旧的“照片 URL + 直接损伤费账单”路径，依次执行现场取回、合同计费、客户/账款结算。正式启用前必须先完成迁移和只读分类，不得手工伪造文件哈希、客户签署或合同价格。

## 当前就绪状态（2026-08-31）

- 当前仅完成代码与配置就绪：新写入只在 `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED` 为精确字符串 `true` 时准入；false、缺失、空值、大小写或空白变体均拒绝无既有受管事实的新 case。已有清单/差异/收费/客户响应/处置/证据包、法催或退车确认单电子签事实仍必须投影三阶段 UI。
- `.env.staging.images.example` 是 image-admission 的目标配置，非部署、镜像、运行时或人工验收证据。根与生产示例保持 fail-closed 默认值。
- PR 审核与 CI、合并、release image、受控 Staging runtime、Admin/Portal 视觉复验和人工验收均未完成。不得因本手册或本地测试而关闭任何 ACC 项或声明已发布。

## 发布顺序

1. 部署包含 `20260826030000` 至 `20260826036500` 的全部迁移，以及其后的主线迁移。
2. 在目标数据库执行以下校验；校验和、缺失迁移或重复迁移任一项不安全时停止发布，不得以 `migrate status` 单独代替校验和检查：

   ```bash
   pnpm prisma:migrate:checksum:verify
   pnpm prisma:migrate:status
   ```

3. 保持 `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=false`，执行：

   ```bash
   pnpm stage1:return-closure-backfill:dry-run -- --output output/stage1-return-closure-dry-run.json
   ```

4. 逐项处理报告中的 `MISSING_SIGNED_DELIVERY_BASELINE`、`MISSING_SIGNED_CONTRACT_FILE_AUTHORITY`、`SIGNED_CONTRACT_FILE_AUTHORITY_CONFLICT`、`MISSING_RETURN_CHECKLIST`、`MISSING_CONDITION_DELTA`、`MISSING_SETTLEMENT_PUBLICATION_FACT` 和 `MANUAL_CLAUSE_REVIEW_REQUIRED`。合同文件只有同时具备合同 `SIGNED → ARCHIVED` 事实、精确绑定当前合同/文件/哈希的归档审计以及一致的 `FileObject.contentSha256` 才能成为签署合同权威；生成阶段 PDF 已有的哈希不能替代签署归档审计。缺失哈希只能依据该归档审计以 compare-and-set 方式补齐，审计缺失或哈希冲突必须进入人工隔离。历史 URL 只能转为 `LEGACY_EXTERNAL_REFERENCE`，不能声明为已校验文件；业务数据库保留原始引用，审批报告、控制台输出及证据包必须移除 URL 用户信息、查询参数和片段。
5. 经审批后执行确定性写入：

   ```bash
   STAGE1_RETURN_CLOSURE_BACKFILL_APPLY=1 pnpm stage1:return-closure-backfill:apply -- --output output/stage1-return-closure-apply.json
   ```

6. `--apply` 会隔离 `quarantinedClosureIds` / `quarantinedContractIds`，对其余安全订单继续确定性写入；只要仍有人工审查项，命令仍以非零状态退出，不能据此把问题订单视为已迁移。`clauseConflicts>0` 时全部停止写入。
7. 重跑 dry-run，确认 `clauseConflicts=0`、写入计数归零、`manualReview` 为空且 `quarantinedClosureIds` / `quarantinedContractIds` 均为空。确认报告中的账单/处置指纹仍与数据库当前事实一致，并核对每一条历史 `FINALIZED` 结算版本均存在 `published_at` 和 `publication_snapshot`。任一隔离队列未清零时，不得打开功能开关。
8. 在所有 `MISSING_SETTLEMENT_PUBLICATION_FACT` 清零后，`--apply` 会执行数据库约束验证。必须确认：

   ```sql
   SELECT convalidated
   FROM pg_constraint
   WHERE conname = 'subscription_closure_settlement_publication_check';
   ```

   结果必须为 `true`。不得伪造历史发布时间或客户可见快照；缺失事实只能依据已归档审计/通知权威记录走受审批修复。

9. 再次保存 dry-run 报告并由发布负责人确认所有人工队列为零后，设置精确值 `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED=true`，重启 API，再发布同一提交的 Web 镜像。该值之外的任何值都不准入新的受管退车；关闭后仍不得把已有清单、差异、收费、响应、处置、证据包、法催或退车确认单电子签事实降级到旧 UI。

## Staging 验收门槛

- Admin 受管闭环中不再显示照片 URL 录入或旧的直接损伤费出账入口。
- 客户签署、拒签和缺席三条现场路径均能继续；缺少必需证据只显示业务等待，不进入死信。
- 法大大未完成签署需要更正时，管理员先在法大大后台撤销原任务，再回到订单页执行“取消签署并更正”；系统必须验证供应商已撤销后才允许生成新任务。
- 差异只能由已归档交车基线和当前退车清单生成；待判责任未全部确认时不能正式计费。
- 每个客户收费项同时显示合同条款、差异项、受管证据、计算结果和账单关联。
- Portal 仅需一次最终方案反馈；可接受或逐项争议，接受后复用主动支付。
- 未清应收只有明确争议/催收/法催归口后才允许运营完结；财务状态继续保留。
- 证据包可下载、哈希稳定，不包含 provider payload、密钥或无关个人敏感信息。
- 签署合同和财务凭证必须有上传时持久化的 SHA-256 权威值；导出时重新下载校验，不允许以导出当下临时计算值替代原始权威值。

回滚时先将开关恢复为 `false` 并重启同一版本的 API/Web。该开关只停止尚未进入受管闭环的新流量；已经产生清单、差异、收费、响应、处置或证据包事实的订单必须继续显示并使用三阶段闭环，旧损伤费入口仍保持阻断。不可删除已生成的不可变事实、把在途订单切回旧流程，或回滚已执行迁移。
