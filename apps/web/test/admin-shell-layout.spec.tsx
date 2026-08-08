import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminShellFrame } from "../src/components/admin-shell-frame";

describe("AdminShellFrame", () => {
  it("renders separate menu and content scroll regions", () => {
    const html = renderToStaticMarkup(
      <AdminShellFrame
        brand={<span>运营中台</span>}
        header={<span>登录用户</span>}
        menu={<nav>功能菜单</nav>}
        menuScrollRef={createRef<HTMLDivElement>()}
        onMenuScroll={() => undefined}
      >
        <main>详情内容</main>
      </AdminShellFrame>
    );

    expect(html).toContain("运营中台");
    expect(html).toContain("登录用户");
    expect(html).toContain("功能菜单");
    expect(html).toContain("详情内容");
    expect(html).toContain('data-testid="admin-menu-scroll"');
    expect(html).toContain('data-testid="admin-content-scroll"');
  });

  it("hides the menu scrollbar without disabling menu scrolling", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/components/protected-shell.module.css"),
      "utf8"
    );

    expect(css).toMatch(/\.menuViewport\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.menuViewport\s*\{[\s\S]*?scrollbar-width:\s*none/);
    expect(css).toMatch(
      /\.menuViewport::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/
    );
    expect(css).not.toMatch(/\.menuViewport\s*\{[\s\S]*?overflow-y:\s*hidden/);
  });
});
