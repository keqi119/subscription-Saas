"use client";

/* eslint-disable @next/next/no-img-element -- Controlled source documents are authenticated API streams. */

import { EyeOutlined } from "@ant-design/icons";
import { Flex, Spin, Typography } from "antd";
import { useState } from "react";

import { buildPortalAssetUrl } from "../../lib/portal-api";
import type { PortalCatalogSourceDocument } from "../../lib/portal-types";

export function PortalSourceDocumentImage({
  document
}: Readonly<{ document: PortalCatalogSourceDocument }>) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed || !isControlledSourcePreview(document.previewUrl)) {
    return null;
  }

  const sourceUrl = buildPortalAssetUrl(document.previewUrl);

  return (
    <figure
      data-portal-source-document={document.section}
      style={{ margin: 0, width: "100%" }}
    >
      <Flex align="center" justify="space-between" style={{ marginBottom: 10 }}>
        <Typography.Text strong>{document.title}</Typography.Text>
        <a href={sourceUrl} rel="noreferrer" target="_blank">
          <EyeOutlined /> 查看原图
        </a>
      </Flex>
      {!loaded ? (
        <Flex align="center" gap={8} justify="center" style={{ minHeight: 120 }}>
          <Spin size="small" />
          <Typography.Text type="secondary">原件图片加载中</Typography.Text>
        </Flex>
      ) : null}
      <img
        alt={`${document.title}原件`}
        loading="lazy"
        onError={() => {
          console.warn("portal source document preview unavailable", {
            section: document.section
          });
          setFailed(true);
        }}
        onLoad={() => setLoaded(true)}
        src={sourceUrl}
        style={{
          border: "1px solid #e5eaf2",
          borderRadius: 8,
          display: "block",
          height: "auto",
          maxWidth: "100%",
          width: "100%"
        }}
      />
    </figure>
  );
}

function isControlledSourcePreview(url: string) {
  return /\/source-documents\/(?:CONFIGURATION_SHEET|CONDITION_REPORT)\/preview(?:[?#]|$)/.test(
    url
  );
}
