"use client";

import { Layout } from "antd";
import type {
  ReactNode,
  RefObject,
  UIEventHandler
} from "react";

import styles from "./protected-shell.module.css";

const { Content, Header, Sider } = Layout;

export function AdminShellFrame({
  brand,
  children,
  header,
  menu,
  menuScrollRef,
  onMenuScroll
}: Readonly<{
  brand: ReactNode;
  children: ReactNode;
  header: ReactNode;
  menu: ReactNode;
  menuScrollRef: RefObject<HTMLDivElement | null>;
  onMenuScroll: UIEventHandler<HTMLDivElement>;
}>) {
  return (
    <Layout className={styles.shell}>
      <Sider
        breakpoint="lg"
        className={styles.sider}
        collapsedWidth="0"
        width={248}
      >
        <div className={styles.siderInner}>
          <div className={styles.brand}>{brand}</div>
          <div
            className={styles.menuViewport}
            data-testid="admin-menu-scroll"
            onScroll={onMenuScroll}
            ref={menuScrollRef}
          >
            {menu}
          </div>
        </div>
      </Sider>
      <Layout className={styles.rightLayout}>
        <Header className={styles.header}>{header}</Header>
        <Content
          className={styles.content}
          data-testid="admin-content-scroll"
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
