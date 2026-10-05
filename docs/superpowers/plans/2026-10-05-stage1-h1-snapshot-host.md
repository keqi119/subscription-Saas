# H1 一次性快照制作宿主准备

> **For agentic workers:** 使用 superpowers:executing-plans 实施；账号脚本由一个中等推理子 agent 编写，root 负责应用和实际宿主核验。

**Goal:** 落实已批准 H1 制作方案的账号与宿主前提，为后续固定入口/JIT 接线提供真实事实。阶段 1 的最终目标仍包括真实 producer、R2/R3、两项迁移和 R4。

**Architecture:** root 仅进行固定安装、资源准备及独立检查，`stage1snapshot` 不获得 sudo、Docker socket 或已有私钥访问。制作只使用每次新建的 1 GiB LUKS2 卷；本切片先验证宿主确实支持其生命周期，不导出真实数据、不注册 Runner。

**Tech Stack:** H1 Alibaba Cloud Linux 3、Python 3.6、cryptsetup 2.3.7、systemd 239/cgroup v1，复用已安装工具。

**Spec:** `docs/acceptance/2026-10-01-stage1-snapshot-producer-host-decision.md` 的选择 A；SHA-256 `d0f4b6a92781de81ff5c0948565b490940900fc401363e9c467955b32d94765d`。用户于 2026-10-05 明确“批准H1 一次性制作”。原批准稿保持字节不变；本记录前向确认选择，原 WSL 限制不再用于阻断已批准的 H1 路线。

## 约束与审查重点

- 无商用 KMS、新业务功能或全量测试矩阵；不重新申请 Docker/主机许可。
- 三 job、精确五标签和 root 固定入口的准入要求保留。两个主机选项原本都使用 JIT；没有选择非 Actions 路线。
- 现有 Ed25519/RSA 主备卷保持隔离，不能充作制作临时卷。
- swap 必须实际停止，core 限额必须为零；容量不足拒绝，不能向普通磁盘回退。准备检查不等于 job 准入或真实销毁证明。
- 既有同名资源不符合预期时拒绝接管；新账号不能读取源配置/私钥或访问 Docker。
- LUKS 使用内存中的独立随机高熵 key；不得把 key 写入 argv、环境变量、日志或普通磁盘。合成探针清理后恢复原有 swap，真实制作期间另由受控执行保持停用。

## Task 1：固定账号及目录

**Files:** 新增 `scripts/release/prepare-h1-snapshot-host.py`；记录 `docs/acceptance/2026-10-05-stage1-h1-snapshot-host-readback.md`。

**Interfaces:** root 运行 `python3 prepare-h1-snapshot-host.py --check|--apply`，仅输出非秘密 JSON。固定 `stage1snapshot`、root-owned home `/var/lib/stage1snapshot`、root-only `/var/lib/subscription-saas/snapshot-volumes` 和专用 core limits 文件；不提供可替换路径/账号参数。

- [x] 只读核实既有账号、路径、实际权限与资源（`2264f1`、`503856`）。
- [x] 编写脚本并进行语法检查；限定审查结果见 acceptance 记录。
- [x] `a5416c` 先确认缺失，应用后修正实际账号过期差异，新 SSH `fac9f7` 全部检查通过。

## Task 2：实际宿主加密生命周期

**Files:** 忽略目录 `.superpowers/sdd/2026-10-05-stage1-h1-snapshot-host/` 中保留单次探针及非秘密结果；更新同一 acceptance 记录。

**Interfaces:** 单次 root 合成探针只在新 UUID 对应的固定根目录中创建 1 GiB 卷，记录 UUID、mapper、挂载、keyslot 与清理事实，不生成 producer/completion 成功原件。

- [x] 实测停用 swap，core 限额零并临时禁止 systemd core 管道；停用后约 862 MiB 可用（`ab4985`）。
- [x] 新建 1 GiB LUKS2、打开、格式化、挂载及合成标记读回。
- [x] 卸载、关闭、keyslot 清空和旧 key 拒绝；删除本次资源、恢复 swap/core。独立 SSH `2256de` 确认目录/mapper 无残留及 Staging PG 健康。
- [x] 两次 cryptsetup 兼容性失败及各自清理记录保留，第三次 `ab4985` 才计完整通过。

## 后续真实接线

以上事实通过后继续固定 adapter、低权限进程/数据库工具的受限交接和 root JIT 控制。替换旧明文 workflow 为 admission/data/custody；实际 run 确定后，按用户既有要求提交精确 publisher/custody RAM 草案。随后只构建必要的同一最终候选并运行 R2/R3、获准迁移与 R4。不得把本宿主切片作为阶段 1 收口。
