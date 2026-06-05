import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PLATFORM_NAME } from "@subscription-saas/shared";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: PLATFORM_NAME,
  description: "上海二手纯电车辆订阅后台运营中台"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
