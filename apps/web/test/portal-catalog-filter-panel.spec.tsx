import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  countAppliedCatalogFilters,
  PortalCatalogFilterPanel
} from "../src/app/portal/catalog/portal-catalog-filter-panel";

describe("PortalCatalogFilterPanel", () => {
  it("renders a closed disclosure with the applied filter count and one form", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogFilterPanel activeCount={2} onToggle={vi.fn()} open={false}>
        <form aria-label="车辆筛选">筛选表单</form>
      </PortalCatalogFilterPanel>
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("筛选条件（已启用 2 项）");
    expect(html).toContain('data-open="false"');
    expect(html.match(/aria-label="车辆筛选"/g)).toHaveLength(1);
    expect(html.match(/筛选表单/g)).toHaveLength(1);
  });

  it("renders the same content in an open disclosure without an empty count badge", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogFilterPanel activeCount={0} onToggle={vi.fn()} open>
        <form aria-label="车辆筛选">筛选表单</form>
      </PortalCatalogFilterPanel>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-open="true"');
    expect(html).toContain("筛选条件");
    expect(html).not.toContain("已启用 0 项");
    expect(html.match(/筛选表单/g)).toHaveLength(1);
  });

  it("counts only non-empty submitted string filters", () => {
    expect(
      countAppliedCatalogFilters({
        brand: " NIO ",
        city: "  ",
        model: undefined,
        modelDefinitionId: "model-1"
      })
    ).toBe(2);
  });
});
