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

## 2026-09-27 本桶公共访问补充读回

以上初版所列 BPA 待确认状态已有新事实：通过 139.196.227.195 既有项目身份 `deploy-codex-staging-user`，使用现有精确 API 镜像中的 ali-oss 6.23.0，新增读取 GetBucketPublicAccessBlock 与 GetBucketPolicyStatus，均实际返回 200，分别为 `BlockPublicAccess=true`、`IsPublic=false`。RequestId 为 `6AB85C5E1171CD3634D5CB14` 和 `6AB85C5E1171CD363402CC14`，因此无需更改该桶配置。未重复前五项桶读取，未执行任何 PUT 或对象操作；读取容器已确认移除，业务容器未启动。

两个 native XML、实际 exit 0 和清理结果保存于隔离树 Task 10 scratch 的 `bucket-public-readback.json`，有限脚本同名 `.py`。初次 metadata 探针因服务器 Python3.6 不支持 `capture_output` 而失败的原件另存；修正调用方式后才执行上述 OSS 请求。凭据只经服务器内存/stdin 交付，没有写入 argv、文件或日志。

这是既有项目 RAM 身份的实际观察，**不是拟配置独立 audit-reader 的验证**。BPA 与非公开策略已确认，但 IAM/OIDC 双角色、真实对象保管/attestation、H1 主机加密与备份仍未完成；未因此关闭 H2 或阶段 1。

## 2026-09-27 expected-schema 原响应读取接缝

隔离分支提交 `09bacf942d3e11a991e461911e8da513d8148135`，父提交 `2b42e5d5ec7c29fe91ca6b02cb20c29579431c03`。仅修改既有 storage/test 和两份既有计划的私有接口说明。原三个存储方法的返回值保持，新内部 `readWithEvidence` 在同 protected run/attempt 下，经同一独立 reader 一次读取对象 Get/Head/ACL 及六项 bucket 来源；没有新增 client、公开 export、CLI、共享 Schema、依赖或工作流激活。

原 body/XML 字节与有限响应字段采集记录分别保存，严格核根节点、投影、对象摘要与元数据；Head 记录关联六项桶原响应，返回去重的有限 raw 闭包。SDK 解析后的 headers 明确不是 HTTP 原报文。合法空白版本 XML 的误拒绝已复现并最小修复，原字节未变。独立审查另发现跨 await 重读 caller key 可使物理路径与摘要脱离；修复前置固定 logical key、physical key 和 expected digest，真实错误接受 RED 与定向 GREEN 均保留。修复差异复审无新增 Important/Critical。

本段实际验证：修复前新增定向 3/3、受影响旧断言仅一次 1/1；唯一审查修复后仅新增回归 1/1，均 actual exit 0，失败/跳过/取消/todo 为 0。语法、ESLint、diff-check 通过；Prettier 当前两文件 exit 1，精确 base 同样 exit 1，保留现有 compact 风格，没有将格式检查记作通过。首次测试语法准备失败、原源缺方法 RED、空白 XML RED、初次 lint 和所有前后摘要均保留。未重跑旧 11 项、parent、foundation169 或业务全套。测试为本地离线 SDK request 替身；根后置观察本机 Node v24.14.0，日志未单独固定版本，不能称最终 Node22 镜像验收。

最终 source SHA256 `5be582dfa7b7fe4d95e7b548e95c06e6ec181fe27e7d47722aaa855fabe9a954`，test `df3fd3fef2c1667c40d17a0a7220e5d0d865aa06bfe0c0de202db64b1cd7b32b`。原件在隔离树 Task 10 scratch 的 `native-custody-readback/`：report、原审查 freeze、fix 前快照、22 项 fix-hashes、RED/GREEN、两次审查完整保留。主控核对最终日志、摘要与暂存四文件后提交。本开发轮 preflight 的 prisma validate exit 0；禁用 dotenv/无 DATABASE_URL 的 migrate status exit 1（datasource.url required），未连接 DB。

后续同一受保护作业仍须按 digest 合并 producer 的有限 subjects，仅从本次 H2 已成功写入事实复用原 proof，不重复 PUT 或把碰撞当成功；然后完成实际私密保管、两 subject attestation、owner 固定导入和 R2 reader。当前返回的 collector 原件不替代上述事实。真实 WORM CreationDate 原 XML 尚需在接入时核实与现有带 Z 规则相容；没有据官方示例猜改旧合同。**真实 H1/H2/expected 输入、完整 R2、R3/R4 和阶段 1 继续开放，未整合发布候选或部署。**
