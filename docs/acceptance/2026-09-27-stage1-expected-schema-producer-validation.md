# Stage 1 独立 expected-schema producer 限定验证

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
