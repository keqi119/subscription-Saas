# Stage 1 H2 私有存储适配层限定验证

隔离工作树 `stage1-r22-launcher-20260926` 提交 `356f0fbd4748e3816e8e0d7f0314eb888021ac6f`，父提交 `42bb7ec48ee076505768364a7f788d809cb2b566`。仅新增内部 storage adapter、对应测试及现有 catalogs/manifest 登记，未整合主候选或启用工作流。

适配层固定用户指定的现有 OSS bucket、账号和区域，核验当前 protected GitHub build 身份，再分别取得 writer 与 audit-reader 的短期 STS 身份。逻辑 evidence/receipt key 映射至同一已核验 run/attempt 前缀；写入禁止覆盖，独立读取实际私有 ACL、210 天 Locked WORM、禁用版本、AES256、非公开策略和公共访问阻断，以及对象原字节、大小、写入时间和有效保留期。角色/OIDC provider/公共访问阻断仍是待实际配置的绑定，不能据此声称云端就绪。

独立 Sol high 审查发现两项 Important：SDK debug 可输出临时认证头，以及 SDK 丢弃 XML 根节点后将错误版本响应误判为 Disabled。修复先按实际 vendor debug 规则拒绝取得凭据，并改用保留根节点的原始版本 XML 验证。原审查者仅复核这两处，结论 **Approved**。

实际证据：

- 初始缺模块 RED exit 1；初次 lint 缺 Node URL globals 的失败原件保留，修正后 lint 通过。初始冻结版本单次 9/9、登记 179 项及静态检查通过。
- fix1 的两个反例分别在旧冻结生产代码上真实失败，exit 1。最终 lint 在冻结前通过；冻结后唯一完整新测试文件 **11/11，exit 0**，语法、diff、登记检查通过。未运行额外业务、数据库或完整发布套件。
- 主控核对实际日志、四文件冻结摘要、精确暂存范围和提交前后摘要，提交后工作树 clean。source SHA256 `e086802465ff853ef52921ca970dbd01fa9f21b22a410283a2e7e0200059bb86`，test `fce3e00b424ef001bd2c9bc4e8581667e6e896f038f181b4860f4ad6427b22aa`。

最初九份 scratch 原件误写到仓库根 `.superpowers/h2-storage-binding-20260927/`，完整保留；主控逐字节复制至隔离工作树 `.superpowers/sdd/2026-09-25-stage1-trusted-build-input-preparation-plan/h2-storage-binding/` 并验证摘要。fix1 的 08–14 日志、freeze、diff、review 和 commit evidence 均在后者。没有覆盖旧原件。

这些是本地 Node24 离线 fixture 验证；不是实际 OIDC/IAM、OSS 独立读写、最终 Node22 或签名证据。下一步补 producer 收据到既有 fixed consumer 的限定衔接验证，并在管理授权可用后落实云配置及真实读回。**H2、R2 和阶段 1 仍未关闭。**
