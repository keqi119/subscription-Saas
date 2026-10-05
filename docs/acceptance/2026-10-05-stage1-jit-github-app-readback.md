# H1 GitHub App 创建与安装读回

本记录前向补充 [精确配置草案](2026-10-05-stage1-jit-github-app.md)，原草案字节及 SHA-256 `0b4c91ddbbf7ca26a4999cd2b7436f415336d60d2e29756b20c0fb57f667533c` 保持不变。用户在浏览器实际提交创建，并于 2026-10-05 明确回复“已点击install”。

## 已完成

- App：`keqi119-stage1-snapshot-jit`，ID `5196151`，所有者 `keqi119`。
- Installation ID：`168113687`。安装页实际显示成功通知、`Only select repositories`、唯一仓库 `keqi119/subscription-Saas`（ID `1253231368`）。
- 权限：Administration write；Actions、Contents、Deployments、Metadata read，与草案一致。无新组织或账号权限，Webhook、用户 OAuth 关闭。
- H1 Manifest 接收端实际返回 `CREATED_AND_STORED`（`fae2ae`、`4dbd77`）。完整配置已独占存入草案指定加密主、备卷，两份读回一致；公开密钥 SPKI SHA-256 为 `5d3ed578d6090079cbaa4d5c54c24cd2bda1175aa5b4fe53cf89e8e464c41291`。
- 接收 worker 退出后，加密卷已关闭，swap 和 core 配置已恢复；私钥未下载到 Windows、仓库或工作流。

浏览器安装截图及非秘密 JSON 保存在忽略目录 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/`。一次性 Manifest 本机接收服务在完成后已关闭（`4d1f88`、`ac34dd`）。

## H1 独立身份核验

实际 `49c473` 返回 `INSTALLATION_VERIFIED`：受保护 worker 重新读回主、备配置及公钥指纹；固定 root-owned Node 签发短期 App JWT，GitHub `GET /app` 和目标仓库安装 API 验证相同 App、Installation、所有者及五项权限。仅申请 Metadata read 的安装令牌，未缩小 repository_ids 后列出其全部可访问仓库，实际总数为 1 且 ID 为 `1253231368`。最后 `DELETE /installation/token` 返回 204，令牌已撤销。

worker 实际退出后卷关闭、swap/core 恢复均通过。核验脚本 root:root 0600 安装于 `/run/stage1-github-app-inspect-20261005.py`，最终 SHA-256 `bc8aa58e48f189c438d9a8c3198b0afc089c01e36d2d8c0735392cd18998e06a`。这不是 Runner 注册，也未签发供 job 使用的令牌。

首次核验 `2fb561` 失败，原错误包装未保留步骤码；加入受限错误码后 `994724` 明确为 `NODE_IDENTITY`。原因是核验脚本误指向既有 `/usr/local/bin/node`；修正为此前已核验的 `/opt/subscription-saas/snapshot-adapter/v2/runtime/node` 后才取得上述成功。`5ea9dd` 独立确认失败后卷已关闭、swap/core 恢复，`5e3e5c` 确认专用 Node root:root 0555 和已批准摘要一致。失败发生在 JWT 签名之前，未申请安装令牌。原系统 Node 未修改。

## 同轮低权限数据库工具接线

`snapshot-postgres-tools.mjs` 新增 native 回调和归档展开入口：固定 `/usr/bin/pg_dump`、`/usr/bin/pg_restore` 17.11，仅 loopback 和已验证端口；Linux 当前 UID 的 0700 工作目录、独占 0600 passfile、固定子进程环境、输出与时间上限、进程组退出检查。未知退出状态保留凭据目录并返回清理失败。原 Docker 调用路径保留，未授予低权限任务 Docker 或 sudo。

- Linux 相关测试 `fecb13`：9/9 通过，零跳过；Windows 上原有 6 项被既有 Linux-only 工作区条件拒绝，保留该环境限制记录。
- 实际 H1 合成探针 `c9cf49`：固定 PostgreSQL 17.11 镜像内以 UID 992 / GID 988 执行实际 native 回调；MVCC 期间源表新增第二行，导出和恢复仅包含最初一行，归档展开成功，passfile 已清理。探针容器及其文件实际移除。只有合成数据，未连接 Staging 源库。
- 探针第一次在本机依赖定位阶段遇到 ESM-only 包不支持 `require.resolve`（`de6f90`），尚未访问服务器；改为复制锁定依赖实际文件后完成上述实机验证。
- ESLint 无新增错误；旧 Docker 路径保留既有一项 `no-unsafe-finally`。未重复全量测试或变更业务行为。

实现已提交并推送 `37c7527c`（`4fef19`、`19b120`）。契约核验 `888332`：283 文件、91 schema、13 command、128 migrations；repository digest `sha256:a56d2d894ff09ef80f042e4200bdcfb9f2502da022c0dd57d06494c7ed122d04`。数据库测试分类 `79b4af`：103 项候选、39 项真实 gate、64 项明确例外、0 未分类；新增测试仅使用 process doubles，例外不豁免实际制作或数据库门槛。

## 剩余范围

App 安装、宿主准备和 native 工具验证不代表完整制作流程：root 固定入口、受限任务交接、真实 JIT 注册/注销、admission/data/custody workflow、独立 OSS 发布/保管身份仍须接通。之后继续同候选 R2/R3、两项获准迁移和 R4。

本轮实际 Prisma 只读检查 `b8d0d3` 仍为 128 项迁移、仅两项已知待应用（`20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`）；schema validate `bb6856` 通过。未导出 Staging 数据、触发旧明文 workflow 或宣称阶段 1 完成。
