import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortalProfileTabs } from "../src/components/portal/portal-profile-tabs";
import {
  buildPortalProfileHref,
  normalizePortalRedirect
} from "../src/lib/portal-profile-navigation";

describe("Portal profile navigation", () => {
  it("preserves only Portal-local return targets", () => {
    expect(normalizePortalRedirect("/portal")).toBe("/portal");
    expect(normalizePortalRedirect("/portal/catalog/vehicle-1?period=24")).toBe(
      "/portal/catalog/vehicle-1?period=24"
    );
    expect(normalizePortalRedirect("//evil.example/portal")).toBeNull();
    expect(normalizePortalRedirect("https://evil.example/portal")).toBeNull();
    expect(normalizePortalRedirect("/admin/applications")).toBeNull();
  });

  it("builds both profile tab links with the same safe redirect", () => {
    expect(buildPortalProfileHref("basic", "/portal/catalog/vehicle-1")).toBe(
      "/portal/me?redirect=%2Fportal%2Fcatalog%2Fvehicle-1"
    );
    expect(buildPortalProfileHref("materials", "/portal/catalog/vehicle-1")).toBe(
      "/portal/materials?redirect=%2Fportal%2Fcatalog%2Fvehicle-1"
    );
    expect(buildPortalProfileHref("materials", "https://evil.example")).toBe(
      "/portal/materials"
    );
  });

  it("renders a shared basic-profile and document-material tab bar", () => {
    const html = renderToStaticMarkup(
      <PortalProfileTabs activeTab="basic" redirect="/portal/catalog" />
    );

    expect(html).toContain("基本资料");
    expect(html).toContain("证件材料");
    expect(html).toContain("/portal/me?redirect=%2Fportal%2Fcatalog");
    expect(html).toContain("/portal/materials?redirect=%2Fportal%2Fcatalog");
    expect(html).toContain("ant-tabs-tab-active");
  });
});
