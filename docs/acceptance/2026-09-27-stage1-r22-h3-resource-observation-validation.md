# Stage 1 R2.2：H3 资源读回增量验证（2026-09-27）

本轮继续已批准 R2 计划中的固定父输入 IO。R2.2 与阶段 1 **尚未收口**；本报告不是实际 H3、数据库迁移、最终镜像或线上验收记录。

## 实现范围

在已有 H1/H2/index/H3-A 固定原件校验后，launcher 使用固定只读 Docker 命令核对容器、专属卷、镜像、桥接网络及精确 published 映射。区分容器使用的本地 image ID 与批准的 registry digest；卷必须实际挂载，且不能被其他容器共用。资源完整读回两轮，每个外部调用之后重查原件与 owner 输入，结束后再经 R1 独立读回同一 index/build bytes。

当前增量通过后仍以 `MANUAL_TARGET_OBSERVE_INPUT_REQUIRED` 停止。没有开启会话、创建执行 attempt、读取签名私钥或能力凭证、建立数据库连接、生成 baseline 或启动 Runner。后续 target-observe 必须在真实授权消费后执行 SQL；Docker 输出不能代替 SQL 身份观察。

仅修改既有 launcher 和测试，另增加本验收记录；不新增生产导出、Schema、操作 selector 或 caller adapter。尚未把 WIP 入口加入正式 contract manifest。

## 本轮固定资源约定与裁定

- 审批计划要求 marker 与实际 Docker/卷来源绑定，但未给出标签键。本实现固定使用容器和专属卷的 `subscription-stage1-manual-marker`，值等于既有 approval.marker。
- 目前仅支持 H1 所在主机的固定本地 daemon、明确的 `127.0.0.1:port` 或 `[::1]:port`、普通专用 bridge、PG 17 默认数据目录及默认 entrypoint/command。DNS、代理、远端 daemon、通配监听、共享或驱动重定向卷均拒绝。真实 H3 操作单尚未形成，若真实部署需要其他拓扑，应先扩展并审查映射实现；不能用合成测试值填入真实 profile。
- 技能的 task-start 脚本只识别数字 Task 标题，而现有已批准计划使用 R2.2；因此手工提取原文 brief，未修改计划。此差异只影响记录工具。

资源约定若过窄，代价是合法部署被拒绝，需要后续审查扩展；它不会自动授予执行权限。保留旧失败记录、临时验证账本和工作树，供后续接续。

## 验证与证据

基线：`d854a608cdeac44c9ef47d13e957c540019d8987`。执行目录：`D:/Projects/auto-subscription-platform/.worktrees/stage1-r22-launcher-20260926`。原始日志、输入哈希及执行元数据位于该目录的 `.superpowers/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/`。

代码保留在独立 R22 实施分支，未整合原主候选；原主候选中的前向记录只用于保存接续点，不表示该入口已具备生产发布能力。

本轮使用 Windows、Node 24.14.0；未验证最终 Node 22 镜像。测试使用真实临时文件和 R1 reader，GitHub/ACL/资源观察使用受控替身。另用实际 Docker CLI 连接独占的合成 Engine named pipe，验证生产模板的真实格式化行为，未连接实际 Docker Engine。Docker 的 `--format` 使用 Go 模板，见 [Docker inspect 文档](https://docs.docker.com/reference/cli/docker/inspect/)。

最终 source/test SHA-256 分别为 `5e7afa7406f82341f8a254950b89520f6c52921140d28e7ad31961683ac7f906`、`d1f309a90c01202023b08eeeff6d78a4b68750e7037079de8e3c43a3eb8b8e32`。以下完整同源回归 **237/237、exit 0，fail/skip/cancel/todo 均为 0**；六个输入文件前后摘要一致。UTC `2026-09-26T17:29:59.60156Z` 至 `2026-09-26T17:37:58.1128072Z`（北京时间 9 月 27 日），测试耗时约 478 秒。

```text
node --test scripts/release/launch-manual-stage1.test.mjs apps/release-runner/test/manual-entrypoint.test.mjs apps/release-runner/test/cli.test.mjs
```

最终原件为 `resource.reviewed-final.input.json` / `resource.reviewed-final.result.json` / `resource.reviewed-final.log`，日志 SHA-256 为 `259374cd0566cf5b50724d4d485cc549cf245ee28ec747bb8d3cd7245ffbde59`。不拼接不同快照，也不把 237 项解释为完整 R2.2 或真实资源验收。

独立审查给出一项 Important：完整的卷 Options 与网络 DriverOpts 可能把不符合要求的资源中的秘密带入采集输出。经真实 CLI 的两项秘密标记反例，RED 为父测试及两个子测试 0/3，修复后 GREEN 3/3。现在卷只投影 optionsEmpty 布尔值，网络只投影名称、NetworkID、IPAddress、GlobalIPv6Address；PGDATA 与 entrypoint/command 也仅投影匹配布尔值。没有 Critical 或延后 Minor；按执行技能以单次修复和完整回归验证，未要求第二轮复审。

此前失败全部保留：初始资源测试 6/33（旧路径一律拒绝，不能解释成曾允许执行）；首次 GREEN 32/33；真实 CLI 暴露网络 JSON 模板缺结束括号的 0/1；修复后的中间 34/34；索引在观察期间被替换的 0/1 → 1/1；审查秘密输出反例 0/3 → 3/3。中间轮次与最终套件重叠，不累加。审查前旧候选的 `resource.final` 完整回归因候选被修复替代而主动终止，退出 -1、unchanged=false，**不算通过**。

最终代码的 Prettier、两文件语法、显式六项 Node globals 的 ESLint、diff 检查均返回 0；未声称修复仓库默认 ESLint globals 配置。contract verify 返回 0（128 migrations / 176 files / 68 schemas / 13 command contracts），discovery verify 返回 0（95 candidates / 39 manifested / 56 excepted / 0 unclassified）。R22 的 repository contract digest 为 `sha256:4d7d76745f77bb563e1e17086fd753ff5f320bcea62ef351e30dab1025a9a5d2`，不能替代其他整合分支的摘要。

Prisma 预检：禁用 dotenv 且不设置 DATABASE_URL，`migrate status` 返回 1，原因是缺少 datasource.url；未联系服务器，实际迁移状态未知。`prisma:validate` 返回 0。本轮只改发布基础设施，没有业务或数据库结构变更。

审查未判断的范围由实施方明确保留：未完成的授权/归档/后续阶段由停止门槛隔离，不能据此上线；已获准宿主管理员伪造全部来源或替换工具不在 H1 信任模型防御范围，不能声称抵御该管理员；真实 Engine/DB 与最终 Node 22 镜像仍为 NOT_RUN，代价是部署差异仍可能在 R2.4 暴露。R1 现有 git/gh 环境继承的进一步隔离不属于本轮实现或证明。

## 后续顺序

1. 完成 R2.2 的 target-observe：会话、allocation、签发/消费/撤销重查、固定 observer 凭证、真实只读 SQL、归档独立读回和一次性 baseline。
2. 完成父子 MS2 收发、process collector、持久化/readback/ACK 与 UNKNOWN 处理；expected-schema 来源门槛保持在 target-observe 之后、命令冻结和能力凭证之前。
3. 完成 R2.3 独立 verifier/真实测试入口，然后才登记完整入口并集成 R2.2。
4. 真实 H1 owner/主机/私密目录、H2 私密保管服务及独立 reader、H3 操作单准备齐全后，按已有计划实施 R2.4；如需线上联调，先恢复本系统对应 Docker 环境并核验健康。
5. 最终镜像双环境测试、真实业务 A/B 链路及渠道验收仍按原阶段 1 计划推进。本轮没有替代或完成这些验收。
