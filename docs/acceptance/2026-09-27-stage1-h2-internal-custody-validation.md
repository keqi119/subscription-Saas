# Stage 1 H2 内部 custody producer 限定验证

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
