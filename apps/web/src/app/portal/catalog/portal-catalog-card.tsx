"use client";

/* eslint-disable @next/next/no-img-element -- Listing media previews are private API streams, not optimizer-friendly public assets. */

import { CarOutlined } from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useEffect, useRef, useState } from "react";

import { PORTAL_API_BASE_URL } from "../../../lib/portal-api";
import type { PortalCatalogVehicle } from "../../../lib/portal-types";
import {
  buildPortalCatalogTags,
  buildPortalCatalogTitle,
  formatPortalCatalogMonth,
  formatPortalCatalogMonthlyFee
} from "./portal-catalog-presentation";
import styles from "./portal-catalog-card.module.css";

export function PortalCatalogCard({
  onDetails,
  vehicle
}: Readonly<{
  onDetails: (vehicle: PortalCatalogVehicle) => void;
  vehicle: PortalCatalogVehicle;
}>) {
  const title = buildPortalCatalogTitle(vehicle);
  const registrationMonth = formatPortalCatalogMonth(vehicle.registrationDate);
  const tags = buildPortalCatalogTags(vehicle);

  return (
    <article className={styles.card} data-testid="portal-catalog-card">
      <VehicleCoverImage title={title} vehicle={vehicle} />
      <div className={styles.content}>
        <div className={styles.title} data-testid="portal-catalog-title">
          {title}
        </div>
        {vehicle.subtitle?.trim() && vehicle.subtitle.trim() !== title ? (
          <div className={styles.subtitle}>{vehicle.subtitle.trim()}</div>
        ) : null}
        <div className={styles.facts}>
          <span>{registrationMonth ? `上牌 ${registrationMonth}` : "上牌时间待确认"}</span>
          <span>{vehicle.currentMileageKm.toLocaleString("zh-CN")} km</span>
        </div>
        <div
          className={styles.location}
          data-testid="portal-catalog-location"
          title={vehicle.city ?? "待确认城市"}
        >
          {vehicle.city ?? "待确认城市"}
        </div>
        {tags.length ? (
          <div className={styles.tags}>
            {tags.map((tag) => (
              <Tag color={tag.color} key={tag.label}>
                {tag.label}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className={styles.footer}>
          <strong className={styles.price} data-testid="portal-catalog-price">
            {formatPortalCatalogMonthlyFee(vehicle.monthlyFeeFromAmount)}
          </strong>
          <Button className={styles.detailButton} onClick={() => onDetails(vehicle)} type="link">
            查看详情
          </Button>
        </div>
      </div>
    </article>
  );
}

function VehicleCoverImage({
  title,
  vehicle
}: Readonly<{ title: string; vehicle: PortalCatalogVehicle }>) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (imageRef.current && isCatalogImageFailed(imageRef.current)) {
      setImageFailed(true);
    }
  }, [vehicle.coverImageUrl]);

  if (vehicle.coverImageUrl && !imageFailed) {
    return (
      <div className={styles.media}>
        <img
          alt={title}
          loading="lazy"
          onError={() => setImageFailed(true)}
          ref={imageRef}
          src={buildPortalAssetUrl(vehicle.coverImageUrl)}
        />
      </div>
    );
  }

  return (
    <div
      className={`${styles.media} ${styles.placeholder}`}
      data-testid="portal-catalog-image-placeholder"
    >
      <CarOutlined aria-hidden className={styles.placeholderIcon} />
      <span>暂无车辆图片</span>
    </div>
  );
}

export function isCatalogImageFailed(
  image: Readonly<Pick<HTMLImageElement, "complete" | "naturalWidth">>
) {
  return image.complete && image.naturalWidth === 0;
}

function buildPortalAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${PORTAL_API_BASE_URL.replace(/\/api$/, "")}${url}`;
}
