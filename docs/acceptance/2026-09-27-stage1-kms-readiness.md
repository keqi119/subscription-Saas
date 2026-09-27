# 阶段 1 KMS 配置核查与费用边界

2026-09-27，账号 `1457643390906675`，地域 `cn-shanghai`。本记录只涵盖已有快照加密要求，不新增业务功能或验收门槛。

## 已核实状态

- CLI 原续期会话 `92228` 接受已显示的地域/语言默认值后自然退出 0；没有读取或打印凭据配置。
- 07:39:46 UTC，`sts GetCallerIdentity` 返回上述账号，`IdentityType=Account`，exit 0。
- 07:40:07 UTC，`kms ListAliases` 第 1 页、每页 100 条返回 `TotalCount=0`，所以固定 `alias/stage1-snapshot-custody` 当前不存在。
- 07:41:56 UTC，`kms ListKmsInstances` 同样返回 `TotalCount=0`，该账号上海区域没有可直接复用的实例。此结论不外推其他地域或账号。
- 尚未创建实例、密钥或别名，未调用 GenerateDataKey/Decrypt，未改变任何 RAM 权限。

非秘密 API 读回保存于候选工作区 `.superpowers/sdd/2026-09-22-stage1-r3-final-image-dual-chain-plan/cloud-kms-{alias-renewed,instances}-readback.json`；续期记录为同目录 `cloud-oauth-refresh-pending.json`。

## 按现有合同所需的最小配置

现有 `release/contracts/snapshot-cloud-policy.v1.json` 和 producer crypto 合同要求不可导出的对称 KEK、固定别名、GenerateDataKey-only producer 与独立获准 Decrypt consumer。现有 H2 证据 writer/audit-reader 不能直接扩权代替这两个身份。

适配阿里云的配置为：同账号上海软件密钥管理实例、一个 `Aliyun_AES_256` / `ENCRYPT/DECRYPT` / `Origin=Aliyun_KMS` 密钥及上述别名；使用合同已固定的共享网关 `kms.cn-shanghai.aliyuncs.com`。不需要为了此项更换现有 endpoint schema 或建立跨账号网络平台。原生 CreateKey 的实例参数为 `DKMSInstanceId`，具体值须取实际启用实例。

官方说明默认密钥只用于云产品服务端加密，不能支持本方案的自建应用密码运算。软件实例支持共享公网网关，但密码运算公网开关需要在控制台开启，官方说明不支持 OpenAPI 开启。当前浏览器连接失败，尚不能代为操作该开关；CLI 续期成功不等于浏览器已恢复。

来源：[密钥类型](https://help.aliyun.com/zh/kms/key-management-service/user-guide/overview-of-key-management)、[共享网关集成](https://help.aliyun.com/zh/kms/key-management-service/user-guide/application-access)、[公网开关](https://help.aliyun.com/zh/kms/key-management-service/user-guide/access-keys-of-a-kms-instance-over-the-internet)。CreateKey 参数另已通过本地阿里云 CLI 3.5.1 的 API 帮助核对。

## 费用与执行边界

官方专门的按量计费页标示软件实例 30 元/天、一个密钥版本 0.3 元/天，另加 QPS 等用量项；最低基数为 30.3 元/天，按 30 天计算 909 元，尚未计调用费用。按量页说明创建后即开始收费。包月页标示中国内地软件实例 2,499 元/月；通用 FAQ 与按量页面的支持描述不一致，因此账号实际可购模式、报价及预算仍须在下单前核实，不能把较低公开标价当成已取得报价。

来源：[按量计费](https://help.aliyun.com/zh/kms/key-management-service/pay-as-you-go)、[包月计费](https://help.aliyun.com/zh/kms/key-management-service/product-overview/kms-billing)、[计费 FAQ](https://help.aliyun.com/zh/kms/key-management-service/product-overview/faq-2)。

用户已授权云配置，但此前没有确定该持续付费服务的预算；先取得预算边界，再核实可购规格与实际报价。不会开通会自动转付费的试用来绕过预算选择。采购问题不阻止当前 R2 实现继续。

即使实例、密钥和权限完成配置，仍须等待实际 lawful snapshot 与候选才能冻结 exact key/context、run、source/build、输入使用授权与原件加密读回。这里的配置核查不代表 R3 或阶段 1 收口完成。
