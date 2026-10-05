# H1 一次性 Runner：GitHub App 配置

2026-10-05 用户确认尚无 GitHub App，并授权通过浏览器创建；H1 一次性制作、GitHub 推送/合并/工作流触发的既有授权保持有效。本记录只处理 JIT 身份前提，不代表真实 producer 或阶段 1 收口。

## 精确配置

| 项目                   | 配置                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| 名称                   | `keqi119-stage1-snapshot-jit`                                                                  |
| 所有者                 | `keqi119`，仅此账号可安装                                                                      |
| 安装范围               | 仅 `keqi119/subscription-Saas`，仓库 ID `1253231368`                                           |
| Homepage               | `https://github.com/keqi119/subscription-Saas`                                                 |
| Repository permissions | `administration: write`；`actions / contents / deployments / metadata: read`                   |
| 其他权限               | 不申请组织、企业、账号权限                                                                     |
| Webhook                | 关闭，无订阅事件；Manifest 校验要求提供 URL，填同一仓库地址，不投递事件                        |
| 用户 OAuth             | 关闭，不请求用户身份授权，无用户 OAuth callback                                                |
| 注册 callback          | 本机临时 loopback HTTP 端口，仅接收一次 Manifest code，校验随机 state；不是用户 OAuth callback |

GitHub 的 [repository JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository) 要求 Administration write。这是实际仓库管理权限，平台没有为该 endpoint 提供仅注册 Runner 的更细权限，不能把它描述为只读或仅 Runner 权限。安装范围固定单仓库；H1 固定入口的允许动作仍须独立约束、校验及记录。

Actions read 用于实际 run/attempt/job、review history、admission artifact 和 environment 观察；Contents read 用于固定 ref/commit/workflow/blob；Deployments read 用于 deployment/status；Metadata read 用于仓库身份。只有 Administration write 足够请求 JIT，却不足以完成同一 App 的完整独立观察。依据：[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)、[environments](https://docs.github.com/en/rest/deployments/environments)、[deployment statuses](https://docs.github.com/en/rest/deployments/statuses)。不借用更广 PAT 或把公开仓库匿名读取当作显式身份。

## 私钥交付与使用

使用 GitHub 官方 [Manifest 注册流程](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)。本机接收的是短期、单次兑换 code，通过 SSH stdin 交给 H1；H1 直接向 GitHub HTTPS endpoint 兑换配置。App 私钥不经过 Windows 下载目录，不进入仓库、聊天、job 环境、workspace 或日志。

完整配置先独占保存至既有加密主、备卷，再验证 owner/slug/permissions 和公开密钥指纹，避免单次 code 消耗后因校验失败丢失配置：

- 主档案：`/var/lib/stage1-volumes/main/credential/github-app-stage1-snapshot/config.json`。
- 独立备份：`/var/lib/stage1-volumes/recovery/backup/github-app-stage1-snapshot/config.json`。

目录 root:root 0700，文件 0600；沿用既有 UUID 的 LUKS2 卷，不格式化、不修改原有密钥。处理私钥的 worker 只在 swap 停用、core 禁止期间运行；实际退出后才关闭卷并恢复宿主配置。App 的长期私钥只供 root 控制面签发短期安装令牌，不能交给 Runner。此安装并不批准具体数据 job，也不替代 exact-capability approval、post-approval observation、精确五标签和实际注销证据。

## 当前进度

Edge 自动化连接失败；用户改在内置浏览器登录后，已实际读到 `keqi119` 的创建页。Manifest 首次因关闭的 webhook 缺 URL 而被 GitHub 拒绝，补齐仅用于校验的 URL 后进入官方 `settings/apps/manifest` 最终创建页。尚未提交创建、生成私钥、安装或注册 Runner。

本轮实际 Prisma 只读检查 `b8d0d3`：128 项迁移，仍仅两项已知待应用（`20260925090000_stage1_operational_completion_terminal_shape`、`20260925091000_stage1_operational_completion_settlement_guard`），隧道已关闭。`bb6856` schema validate 通过。没有修改业务代码、运行全量测试或导出 Staging 数据。

H1 接收脚本已独占安装至 root:root 0600 的 `/run/stage1-github-app-convert-20261005.py`，本机及远端读回 SHA-256 均为 `0500b9caec9816e7bfdbddf2fddc7df197ace1a14dd9b034df20c7fc0d50f31e`。`97ea0f` 实际 `--check` 退出 0：既有双卷 UUID/路径身份、内存储备、到 GitHub API 的 HTTPS 连接均通过；此预检没有挂载卷、读取解锁材料或兑换 code。卷内目标不存在和实际密钥保存仍须提交创建后核验。`aaef8d` 只读确认本机既有 DPAPI 解锁文件及目录均为当前用户独占 ACL。
