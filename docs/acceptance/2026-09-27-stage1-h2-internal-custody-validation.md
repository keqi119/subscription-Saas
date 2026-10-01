# Stage 1 H2 内部 custody producer 限定验证

## 2026-09-27 producer 到固定 consumer 衔接增量

隔离分支提交 `a1a968c0a6731bc62755c48c14399d0620765310`，父提交 `356f0fbd`，仅修改 `manual-stage1-trust.test.mjs`。两项 characterization 使用真实 producer、foundation custody 与固定 `verifyManualBuild`：实际产出的收据通过原字节及同 run 的两 subject attestation 绑定；完整一致的历史 `github://` 输入在任何存储写入前被拒绝。原有 pretty JSON fixture 默认行为保持。

最终在 owner-only Linux 临时目录、Node22.22.2 仅运行新增 **2/2，Node/WSL actual exit 0**；108 个执行副本文件逐项 SHA256 与原源码相同，限定 lint/语法/diff 检查通过。首次 WSL Windows 挂载目录 mode777 被真实 consumer 拒绝，TAP 1 pass/1 fail，但未可靠捕获 Node exit；另有 PATH 和遗漏依赖的两次 setup 失败，均保留原件，未声称是业务 RED。修正执行环境时未改变冻结源或放宽权限检查，没有重复完整 suite。

独立 Sol medium 限定审查 **Approved**，主控核对日志和提交前后 hash、精确单文件暂存，提交后 clean。测试 SHA256 `ca99ecfe7f5259a5a03a35ea2f6e606c1e8aa0ab3779e442ad4359a39567a686`。证据位于隔离工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/h2-consumer-integration/` 的 01–20 文件。未发现新生产缺陷；GH 和分离读写存储仍为 double，不能证明真实 IAM/签名或 H2 完成。下述最初内部 producer 记录作为历史保留。

隔离工作树 `stage1-r22-launcher-20260926` 提交 `bbaf9710aa54cebb98eed51f4dba5b308b71f52e`，父提交 `3710f11ab4051b87452af9fd57ea940240ea5663`。仅新增 producer、对应测试，并登记现有 catalogs/manifest；未整合主候选。

内部函数复用 `assertBuildIdentity` 与 `custodyEvidence`，绑定固定 protected job 的 source、workflow、run/attempt 和同一 gh 验证结果中的 certificate/subject/DSSE bundle。proof 必须保持 canonical 原字节；material 保持原始字节，CreateNew 后由 audit-reader 独立 Get/Head，并核对实际服务元数据的至少 90 天保留和 proof 覆盖期。全部成功后只返回既有 receipt；部分失败不回滚、不改 ID 重试、不返回成功。

独立 Sol high 限定审查 **Approved**，无 Important/Critical。主控独立核对四文件摘要和实际日志；提交前后摘要一致，提交后工作树 clean。

实际验证：

- 编号 01 RED：缺少 producer 模块，Node exit 1；这不是旧实现接受坏输入的反例。
- 编号 02 GREEN：唯一新增测试文件 **24/24，Node exit 0**，约 1.41 秒。
- 编号 03：repository contract 登记 **177 entries，Node exit 0**；`git diff --check` exit 0。
- 编号 04 lint：命令漏配 Node 全局 `structuredClone`，1 项 no-undef，exit 1；编号 05 显式配置 Buffer/TextDecoder/structuredClone 后 exit 0，源码未改。不是全仓默认 lint 通过。

摘要在 GREEN 后记录；受测 source/test 在运行中及之后未编辑。未为补冻结顺序而重复测试，审查与提交也未复测。producer SHA256 为 `0c77b22c9012dea4fdde994fa6ac00c8997dfd642bfd5af335b154c9e3b01e08`；test 为 `fec09aadc73fd713f626f4b706bd2a6e7be9ccda91c06e98c0d18089dc7f72d0`。完整四文件摘要、diff、编号日志和 commit evidence 保留在该隔离工作树的 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/`。

本轮沿用已记录的基础设施 preflight：禁用 dotenv、无 DATABASE_URL 的 migration status exit 1，未连接服务器；Prisma validate exit 0。业务及迁移文件未改。测试内存存储不证明实际 IAM 分离，gh JSON 绑定不替代未来真实签名验证。尚未接 storage adapter、workflow、固定 consumer 或真实 OSS；管理 OAuth 仍待完成，角色仍是草稿，**H2 与阶段 1 均未关闭**。后续继续独立 expected-schema producer、真实云配置及既定发布门槛。
