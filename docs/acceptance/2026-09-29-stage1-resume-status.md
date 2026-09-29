# 阶段 1 恢复执行记录（2026-09-29）

阶段 1 尚未完成。保持原定范围：不增加业务功能，不采用商用 KMS，不重复已通过且未受改动影响的长测试。

## 当前环境事实

- SSH 只读查询 `506f37`：139.196.227.195 可连接；`subauto-staging-postgres-1` 健康运行，Staging API/Web 停止，其余列出的容器停止。本轮未启动或停止容器。
- 配置定位 `4dbf26` 与脱敏读回 `731ffd`：服务器使用 `/opt/subscription-saas/.env.staging.images`，已有 DATABASE_URL，容器内目标为 `postgres:5432/subscription_saas_staging`。凭据未输出或写入仓库。此前本地缺少 datasource.url，不能据此推断服务器也缺少配置。
- 线上迁移只读核对 `731ffd`、`97db00`：128 项本地迁移中 126 项已应用；线上 127 行记录包含一项已回滚历史记录及其后续成功记录。无未解决失败、无服务器独有迁移、无同名校验和漂移。
- 仅待应用 `20260925090000_stage1_operational_completion_terminal_shape` 与 `20260925091000_stage1_operational_completion_settlement_guard`。仍按原发布顺序，在候选证据齐备后执行；本轮未写数据库。
- 脱敏查询结果保存在忽略目录，SHA-256：`a6fc04fb2aae74c0f16e7fc52542a1c63c9d53fbcbcaa2b70aadd6d0e08692a1`。初次查询受服务器 Python 3.6 不支持 capture_output 参数影响，兼容修正后只读查询成功；未更改服务器 Python。

## 本轮代码范围

在既有 source 终态之后增加独立的负责人签收入口。它只接受当前会话已完成的准确终态摘要，重新核对原件和撤销链，将签收记录写入 archive/backup 并独立读回。完成 source 不会自动签收；历史读取拒绝孤立、重复或缺失副本的签收。此记录代表负责人绑定会话的一次独立动作，不等于独立人类签名，也不证明跨会话读取或阶段 1 验收完成。

API 入口定向测试 RED `1bca05`、GREEN `d2fb45`（1/1）；纯签收构建/校验定向测试先失败后通过（1/1）。有限只读审查未发现阻断问题。仓库合同检查 `fd25c5` 通过：234 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:7a2275800b75314145c2e4838a16696c35c4b7903a6363c9601bbdcf998aab35`。

仅为新增签收与缺失备份拒绝运行一次既有 Linux 集成用例：`4dc3be` 自然退出 0，1 pass / 0 fail / 0 skip（测试体 1,386,828.753669 ms，进程 1,448,595.395569 ms）。七份暂存源码与冻结测试副本一致（`6d802a`）。日志 SHA-256：`2b1efbc4613d4354d58b0e1e1073dd6e11c9df2bd1a8992a29d642fb7df8fa47`。

正向验证覆盖真实私有文件、可信会话的独立 ACK、双副本、历史重读及删除备份后的拒绝，保留原 UNKNOWN 和 43 项锁。host、GitHub、Engine、PG、39-original reader 仍为合成边界。native holder 的新入口验证了前置条件拒绝；完整 runSourceManifest 生产器及其 holder 正向签收尚未在真实 H1 运行，不能据此宣布线上验收通过。

随后抽取共享撤销链检查，为跨会话读取提供默认零写入的内部接口。原会话显式保留既有 checkpoint 创建行为；只读分支在缺失、孤立或回退时拒绝。新增 3 项定向检查通过；接回原会话后，签名后撤销/回退定向用例 `f46c64` 通过（1/1）。当前全部代码的合同检查 `59bd7a` 通过：235 文件、85 schemas、128 migrations、13 commands，摘要 `sha256:ea8673abf21d032d261ece4d92108172bfe7e1cab7c92424795f720c00d6e214`。此抽取由独立定向检查覆盖，不在此前冻结的 ACK 长测试副本内；完整跨会话 source 读取仍待实现。

## 后续顺序

1. 完成签收集成验证；复用已有历史验证逻辑，提供不创建会话、锁或撤销 checkpoint 的跨会话只读入口。
2. 接通 source 清理及匹配 final，补齐现有 R3 执行链；不新增业务或发布平台。
3. 获得合法数据库快照来源确认，完成同一候选的真实 R2/R3 证据。既有 RAM/加密凭据配置已完成，不重建；之前的 RSA 恢复卷不是数据库快照。
4. 应用上述两项 Staging 迁移、恢复对应 API/Web，完成真实 R4 验收。

数据库快照来源问题仍待答复；现有断点也未授权 push、merge 或 workflow dispatch。当前离线工作不依赖这些动作，继续推进。
