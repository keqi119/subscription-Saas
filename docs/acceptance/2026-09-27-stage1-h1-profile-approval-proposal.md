# Stage 1 H1 发布身份：已批准的精确配置

本配置把已配置的主机、签名公钥和加密目录绑定到本次 R2 隔离验证允许名单。用户已回复“批准此精确草案”，收到后记录批准时间为 `2026-09-27T04:08:59.000Z`。配置内容与下列获批 digest 保持一致；已完成批准原件、owner binding、GENESIS、manifest 和真实主机 loader 验证。目标数据库和角色尚未创建。

实际主机初始化于 `04:14:07Z` 完成；批准原件独立读回后才生成 binding。主机 loader 于 `04:22:56Z` exit 0，读取提交 `d198b813a27a0d21c711ed841ed0c9e2adcafebc` 的原始 H1 源码与依赖子集，10 项主档案/备份/台账读回匹配。该子集不代表完整发布候选或真实 CI；阶段 1 仍未收口。详细边界见[执行记录](./2026-09-27-stage1-cloud-and-runner-checkpoint.md)。

## 已批准的精确对象

- 负责人：`keqi119`；主机：`139.196.227.195`；执行身份：POSIX `uid 0`。
- Profile ID：`9773e084-466a-41de-9bdb-7de7ec8719c6`。
- **Profile digest：`sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541`**；canonical 原件 1,462 bytes，原始字节摘要与此一致。
- 主机指纹：`sha256:9a5d400437a09697e136f885d892159e8cbe7585accf5a60a95afa4c380831b0`。
- 公钥指纹：`sha256:7146f2e00f4a8e70183a64f3e8c7ebfa8e66926f60d18442e3d5ac4a09e408ef`。
- 有效期：北京时间 2026-09-27 11:39:03.374 至 2026-10-27 11:39:03.374（UTC `2026-09-27T03:39:03.374Z` 至 `2026-10-27T03:39:03.374Z`）。
- 允许命令：`db.migrate.deploy@1`、`db.schema.verify@1`。构建来源固定为 `keqi119/subscription-Saas` 的 `refs/heads/main`、`docker-images.yml`、GitHub OIDC 与 GitHub-hosted runner。

## 本次隔离目标的允许意图

| 项目                   | 精确值                                                          |
| ---------------------- | --------------------------------------------------------------- |
| 政策标识               | `stage1-r2-synthetic-20260927`                                  |
| 主机回环端点           | `127.0.0.1:55439`                                               |
| 数据库名               | `s1ci_stage1_r2_20260927`                                       |
| 用途                   | `synthetic-fresh`                                               |
| 观察 / 迁移 / 验证角色 | `stage1_r2_observer` / `stage1_r2_migrate` / `stage1_r2_verify` |
| TLS                    | 必须启用                                                        |

这些是后续 H3 配置必须匹配的允许意图，目前尚未建库、建角色或证明 TLS/权限。SSH 只读检查显示当时 55439 无监听，不等于已保留端口。H3 仍需核对实际容器、卷、数据库身份和最小权限；profile 批准不能代替这些读回或一次具体迁移授权。

## 已配置的加密目录与恢复边界

| 用途     | 路径                                                               |
| -------- | ------------------------------------------------------------------ |
| 签名密钥 | `/var/lib/stage1-volumes/main/key`；引用 `signing-ed25519.pk8.pem` |
| 台账     | `/var/lib/stage1-volumes/main/journal`                             |
| 档案     | `/var/lib/stage1-volumes/main/archive`                             |
| 独立备份 | `/var/lib/stage1-volumes/recovery/backup`                          |
| 会话凭据 | `/var/lib/stage1-volumes/main/credential`                          |

五根已在两个独立 LUKS2 加密卷中建立，实际 uid 0 / 0700；私钥 uid 0 / 0600。保管目标为 90 日，目录创建不证明未来保管已完成。密钥已完成同主机独立备份卷的恢复及签名验证；当前卷默认关闭，未自动解锁。私钥和解锁材料未进入仓库或聊天。

独立解锁材料由当前 Windows 用户 DPAPI 保护；该 Windows 用户的 DPAPI 恢复能力仍是依赖。同盘双卷恢复不等于异机恢复。指定 OSS 桶的密文副本及读回状态见[当天实际执行记录](./2026-09-27-stage1-cloud-and-runner-checkpoint.md)，不以草案代替真实恢复证据。

## 批准及后续限定动作

按 [R1 H1 固定顺序](../superpowers/plans/2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md#h1首次实际身份路径与备份人工停止点)，已收到负责人对上述 digest 的确认并完成前述限定配置。批准摘要为 `sha256:2558d9ba079dd5456780a45e2b94ddac501419d9fbfa325d7f7db4f3169bece1`，binding 摘要为 `sha256:68a627061f135ee52f811f81e9c39283aa3adc9c00a01be566b08a76ec82c9c2`。业务迁移、实际 CI、最终候选同源验证、R2 全链和阶段 1 收口状态仍分别验收。

canonical 原件保存在发布工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/cloud-setup-20260927/manual-stage1-profile.v2.proposed.json`，生成与校验记录为同目录 `h1-profile-proposal.json`。更改草案任何字段均需重新计算 digest，不能沿用本次确认。
