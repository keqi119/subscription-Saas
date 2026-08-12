"use client";

import { Tabs } from "antd";
import Link from "next/link";

import {
  buildPortalProfileHref,
  type PortalProfileTab
} from "../../lib/portal-profile-navigation";

export function PortalProfileTabs({
  activeTab,
  redirect
}: Readonly<{
  activeTab: PortalProfileTab;
  redirect?: string | null;
}>) {
  return (
    <Tabs
      activeKey={activeTab}
      items={[
        {
          key: "basic",
          label: <Link href={buildPortalProfileHref("basic", redirect)}>基本资料</Link>
        },
        {
          key: "materials",
          label: <Link href={buildPortalProfileHref("materials", redirect)}>证件材料</Link>
        }
      ]}
    />
  );
}
