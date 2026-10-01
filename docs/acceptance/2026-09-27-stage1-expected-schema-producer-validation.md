# Stage 1 独立 expected-schema producer 限定验证

## 2026-09-27 固定输入接口与原件取回对齐

隔离分支提交 `3feff2e7e6a419583b69a1550149460f57ecba57`，父提交 `9dec7a8c`，仅修改已有 producer/test。主控在衔接检查中发现初版输出未符合 R2 §2.4 精确 ExpectedProvenance 接口，且缺失调用 PID、事件时间和完整原始输出；此前最小 brief 遗漏了该精确接口，初版限定审查不等于下游兼容通过。

参考库使用无网络、只读根、tmpfs 和 Unix socket，不能如实提供 H3 的卷名或 TCP 身份。私有参考 Origin 的 DOC 修正 `f2bbbd97`（隔离树 `9dec7a8c`）已先获独立 Approved；共享 H3/Schema/授权不变。实现随后输出精确 provenance/四调用/creation-readback 图及有限去重 raw 集合，保留实际 PID、prepared/spawn/close、完整 argv/stdout/stderr。版本调用移至真实创建后，最终 SQL 读回在 script close 后，非空 zero-exit diff 拒绝；migration owner 从实际关系读取。

宿主保留已核源码 bytes；inner PG 真正停止后输出小 manifest，并在容器仍运行时逐对象取回固定 tmpfs 原件、检查文件身份/大小/hash 和独立重开。取完才 release、等待真实 close/exited 0，最后分别 stop/forced rm 精确容器。每个 raw 和完整 canonical JSON 仍最多 1 MiB，未增加卷、网络、挂载或容器，也未将全部原件合并 base64。

实际验证：旧冻结源取得三个真实 RED（格式缺失、非空 diff 被接受、大原件聚合超限），exit 1；修正后定向 3/3。最终 lint 后冻结，唯一完整受影响文件 **7/7、Node exit 0**，lint/语法/登记/diff 检查通过。测试复用原四例，增加三项有限反例；大原件例使用 462831-byte schema、274737-byte lock 和 400000-byte script。未重复业务或完整发布套件。

独立 Sol high 代码审查 **Approved**，无 Important/Critical。主控实际核对日志、冻结摘要和单次两文件提交，提交前后摘要相同、工作树 clean。producer SHA256 `8153475a68f20c9fea1ffe58f32751d2dc3a202dcc97db767139430c38f1c265`，test `2fd6e651d18c51810efa383442901b388072f1b449dca816905c0e97e84bffcf`。01–06 日志/冻结/diff/review/commit evidence 位于隔离工作树该计划 scratch 的 `expected-schema-alignment/` 子目录。

上述仍由离线底层进程 double 驱动真实实现，未运行实际 Docker/PG/CI 或取得 custody/attestation/import。下一步还须用既有私有存储绑定保留实际 Get/Head/ACL 原件、接两 subject attestation 和固定 reader；**Task3、H2、R2 和阶段 1 均未关闭**。下述初版记录保留为历史。

隔离工作树 `stage1-r22-launcher-20260926` 提交 `42bb7ec48ee076505768364a7f788d809cb2b566`，父提交 `bbaf9710aa54cebb98eed51f4dba5b308b71f52e`。仅新增 producer、对应测试及现有 catalogs/manifest 登记；未整合主候选。

宿主内部函数核验实际干净 checkout、proof/material、源码契约与迁移目录，然后以同 proof 的固定 Runner 镜像顺序创建两套独立参考容器。容器采用 postgres 用户、只读根、禁用网络和两个固定 tmpfs，无宿主挂载；镜像内通过私有 Unix socket 创建 PG17.11 参考库，执行迁移、身份及完整迁移/owner/extension 读回、零差异检查并保留 Prisma 原始脚本字节。两次原始输出及稳定事实一致才返回未发布的 schema/script/provenance 和既有 schema-expectation。

完整 git/repository-contract 核验在宿主执行，镜像只复算实际携带的 schema/config/lock/producer/migration 字节。宿主检查 pnpm11.4.0，镜像检查 Node22/Prisma7.8.0/PG17.11；镜像不依赖缺失的 `.git`、完整工作流文件或 pnpm shim。第二个 tmpfs 覆盖 PostgreSQL 基础镜像继承的 VOLUME，避免自动创建持久卷。

独立 Sol high 审查发现唯一 Important：Docker stop 失败会跳过已知容器 ID 的 forced rm。修复后，两项清理分别尝试，仍保留清理失败和精确 ID并拒绝成功。原审查者限定复审 **Approved**，无其他 Important/Critical。

实际证据：

- 01 RED 为缺少模块，exit 1；02 失败为夹具遗漏既有 `pnpm-lock.yaml` 登记，未进入生产路径。原件保留。
- 修正夹具后 03 为 3/3；修正窄 lint 后的 06 为 **3/3，Node exit 0、lint exit 0**；登记、语法与 diff 检查通过。
- fix1 在旧冻结源码上取得真实 RED：stop 失败后 rm 计数为 0；最小修复后的 09 仅运行该反例，**1/1，Node exit 0**。10 的 lint/语法/登记/diff 检查通过。未重复完整文件，不能称最终四项全量已运行。
- 提交前后四文件摘要一致、提交后工作树 clean；主控独立核对最终四文件摘要及实际日志。producer SHA256 `18f6a48c8dd9c8c02c87778302872b41689d1727743f22206c54a1e1e202c55a`，test `53499ab318432d5f3b2ac1c50f2dfc1f1c0f24adec4f4de532c6c2dbdb53e697`。

全部编号日志、初始及 fix1 冻结摘要、限定 diff 和提交证据保留在该工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/`。测试通过底层进程 double 驱动真实宿主/镜像内函数，未运行真实 Docker/PG/CI，没有新增业务功能或迁移。

本增量没有私有保管、签名或固定输入准入能力。后续仍须在真实 protected job 下提供预载的同候选 Runner 镜像，执行参考生成，通过既定 Task2 adapter 保管并独立读取 source/script/record、完成对应 attestations，再接 R2 签发前 gate。**Task3、H2、R2 与阶段 1 均未关闭。**
