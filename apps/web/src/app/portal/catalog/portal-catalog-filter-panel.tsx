"use client";

import { DownOutlined, FilterOutlined, UpOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { ReactNode } from "react";

import styles from "./catalog-page.module.css";

export function PortalCatalogFilterPanel({
  activeCount,
  children,
  onToggle,
  open
}: Readonly<{
  activeCount: number;
  children: ReactNode;
  onToggle: () => void;
  open: boolean;
}>) {
  return (
    <section className={styles.filterPanel}>
      <Button
        aria-controls="portal-catalog-filter-content"
        aria-expanded={open}
        block
        className={styles.filterToggle}
        icon={<FilterOutlined />}
        onClick={onToggle}
      >
        <span className={styles.filterToggleLabel}>
          {activeCount ? `筛选条件（已启用 ${activeCount} 项）` : "筛选条件"}
        </span>
        {open ? <UpOutlined aria-hidden /> : <DownOutlined aria-hidden />}
      </Button>
      <div
        className={styles.filterContent}
        data-open={open ? "true" : "false"}
        id="portal-catalog-filter-content"
      >
        {children}
      </div>
    </section>
  );
}

export function countAppliedCatalogFilters(values: object) {
  return Object.values(values).filter(
    (value) => typeof value === "string" && Boolean(value.trim())
  ).length;
}
