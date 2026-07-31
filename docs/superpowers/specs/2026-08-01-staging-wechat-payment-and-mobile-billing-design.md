# Staging 微信真实支付与移动端账单布局设计

## 背景

`APP20260731153526L9AF` 已进入真实微信 JSAPI 支付验收。当前发现两个问题：

1. Portal 支付单页面在窄屏上直接渲染六列表格，账单编号、类型、状态、金额和日期相互挤压，内容出现溢出和逐字换行。
2. 微信网页授权返回错误码 `10003`。Staging 使用与 production 相同的公众号 AppID 和微信支付商户号，但 OAuth `redirect_uri` 指向 `staging-api.subauto.keybox.cloud`；该域名此前不在公众号网页授权域名中。

截至 2026-08-01，外部微信配置已完成：

- 微信支付商户平台已新增支付授权目录 `https://staging-app.subauto.keybox.cloud/`。
- 微信公众平台已新增网页授权域名 `staging-app.subauto.keybox.cloud`。
- 公众号验证文件已通过 `https://staging-app.subauto.keybox.cloud/MP_verify_HGc1Zvund91Pydr1.txt` 公开访问，HTTP 状态为 200，内容哈希与原附件一致。

## 目标

- Staging Portal 能在微信内完成 OAuth OpenID 绑定，并继续发起真实 JSAPI 支付。
- Production 的公众号授权、支付目录、OAuth 回调和运行容器不受影响。
- Portal 支付单页面在手机窄屏上完整、易读地展示账单明细，不产生页面横向溢出。
- 桌面端继续使用紧凑表格展示，不降低现有信息密度。

## 非目标

- 不修改微信商户号、公众号 AppID、证书或 API v3 密钥。
- 不创建、支付或关闭用户的微信交易；真实付款动作仍由验收人员在微信内完成。
- 不修改 production Nginx、production API 或 production Web 镜像。
- 不改变账单金额、账单状态或支付单业务规则。

## OAuth 与 Nginx 设计

Staging OAuth 回调与 production 采用相同的域名分层方式：用户可见域名负责接收微信回调，Nginx 将唯一的回调路径转发到对应 API。

1. 将 staging API 环境变量设置为：

   `WECHAT_PAY_OAUTH_REDIRECT_URI=https://staging-app.subauto.keybox.cloud/api/portal/wechat/oauth/callback`

2. 在 `staging-app.subauto.keybox.cloud` 的 Nginx server 中增加精确匹配：

   - 外部路径：`/api/portal/wechat/oauth/callback`
   - 上游：`http://127.0.0.1:3101/api/portal/wechat/oauth/callback`
   - 上游请求保留 `Host: staging-app.subauto.keybox.cloud` 和 `X-Forwarded-Proto: https`

3. 仅重建 staging API 容器，使新 OAuth 回调变量生效；staging Web 不因该配置步骤重建。

4. 使用不含真实授权 code 的只读检查验证：

   - Nginx 配置语法通过。
   - 回调 URL 无参数访问能够命中 staging API，并返回应用的 `WECHAT_OAUTH_CODE_OR_STATE_MISSING` 错误，而不是 Next.js 404。
   - API 生成的 OAuth URL 中 `redirect_uri` 解码后严格等于 staging-app 回调 URL。

OAuth `state` 继续由现有 HMAC 机制签名并限制有效期；回调完成后仍只允许跳转到 `PORTAL_BASE_URL=https://staging-app.subauto.keybox.cloud` 下的地址。

## 移动端账单布局设计

支付单页面按视口提供两种等价展示：

- 中等及以上屏幕：保留 Ant Design `Table`，展示现有六个字段。
- 小屏幕：使用纵向账单卡片，每个账单独立展示以下字段：账单编号、类型、状态、应付、待付、到期日。

手机端卡片要求：

- 账单编号可在字符边界换行，不能撑破卡片。
- 标签和值采用双列布局；标签保持稳定宽度，值在剩余空间内右对齐或自然换行。
- 金额和状态保持原有格式化与中文标签映射。
- 多账单时按现有数据顺序垂直排列。
- 支付按钮仍位于“账单明细”标题区域，不改变支付触发逻辑。

桌面表格和移动卡片复用同一份 `PortalPaymentOrderItem` 数据以及相同的格式化函数，避免两套金额或状态逻辑产生偏差。

## 组件边界

新增一个只负责账单展示的 Portal 组件：

- 输入：`PortalPaymentOrderItem[]`
- 输出：桌面表格和移动卡片两种响应式视图
- 依赖：现有账单类型、状态标签映射及金额、日期格式化逻辑
- 不负责：加载支付单、创建支付、OAuth 跳转或调用 `WeixinJSBridge`

支付单页面继续负责数据加载和支付动作，只将 `paymentOrder.items` 传给账单展示组件。

## 错误处理与安全边界

- 微信 OAuth 外部配置必须新增 staging 域名，不替换 production 域名。
- Nginx 使用精确回调路径，避免将 staging-app 下的所有 `/api` 请求隐式代理到 API。
- 验证过程不输出 AppSecret、商户号、API v3 密钥、私钥或完整 OpenID。
- 若部署验证失败，回滚 staging API 环境文件和 staging-app Nginx 扩展配置；production 无需回滚。
- 当前支付单保持未支付状态，部署和验证不得调用 JSAPI 下单接口。

## 测试与验收

### 自动化测试

- OAuth 单元测试断言生成的 `redirect_uri` 使用配置值，并保持回调后只跳转到 staging Portal 允许域。
- Portal 账单展示测试断言移动端视图包含全部六个字段及真实账单值，桌面视图仍存在。
- Web lint、typecheck、test 和 build 全部通过。
- API OAuth 与微信支付相关定向测试、lint、typecheck 和 build 全部通过。

### 运行时验证

- staging API 和 Web 容器健康，镜像标签与本次发布提交一致。
- 公网回调路径命中 staging API。
- 生成的 OAuth URL 使用 `staging-app.subauto.keybox.cloud`。
- 375px 视口下账单明细无页面级横向溢出，账单字段完整可读。
- 验收人员在微信内点击“微信支付”后完成 OpenID 绑定并进入微信收银台。
- 支付结果以后端微信通知和支付单查询为准，不以前端回调单独判定。

## 发布顺序

1. 以测试驱动方式完成移动端账单组件和回归测试。
2. 完成代码质量检查并构建新的 API、Web staging 镜像。
3. 部署 staging-app Nginx 精确回调路由。
4. 更新 staging OAuth 回调环境变量。
5. 仅重建 staging API 和 Web 容器。
6. 执行只读 OAuth、响应式页面、容器健康和数据库状态检查。
7. 将真实付款步骤交还验收人员。

