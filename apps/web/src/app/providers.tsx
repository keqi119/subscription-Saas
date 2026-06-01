"use client";

import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          borderRadius: 6,
          colorPrimary: "#1677ff",
          fontFamily: "Arial, Microsoft YaHei, PingFang SC, sans-serif"
        },
        components: {
          Layout: {
            bodyBg: "#f5f7fb",
            headerBg: "#ffffff",
            siderBg: "#111827"
          }
        }
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
