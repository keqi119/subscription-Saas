const portalBaseUrl = (process.env.PORTAL_BASE_URL ?? "https://app.subauto.keybox.cloud").replace(/\/+$/, "");

const menu = {
  button: [
    {
      name: "订阅用车",
      sub_button: [
        {
          name: "浏览车辆",
          type: "view",
          url: `${portalBaseUrl}/portal/catalog`
        },
        {
          name: "我的申请",
          type: "view",
          url: `${portalBaseUrl}/portal/applications`
        }
      ]
    },
    {
      name: "我的服务",
      sub_button: [
        {
          name: "我的订单",
          type: "view",
          url: `${portalBaseUrl}/portal/orders`
        },
        {
          name: "我的账单",
          type: "view",
          url: `${portalBaseUrl}/portal/bills`
        },
        {
          name: "我的权益",
          type: "view",
          url: `${portalBaseUrl}/portal/entitlements`
        }
      ]
    },
    {
      name: "帮助",
      sub_button: [
        {
          name: "事故报案",
          type: "view",
          url: `${portalBaseUrl}/portal/service-cases/new?type=ACCIDENT_REPORT`
        },
        {
          name: "救援申请",
          type: "view",
          url: `${portalBaseUrl}/portal/service-cases/new?type=RESCUE_REQUEST`
        }
      ]
    }
  ]
};

console.log(JSON.stringify(menu, null, 2));
