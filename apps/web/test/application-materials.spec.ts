import { describe, expect, it } from "vitest";

import { renderMaterialFileNames } from "../src/lib/application-materials";

describe("renderMaterialFileNames", () => {
  it("renders a fallback when material has no file fields", () => {
    expect(renderMaterialFileNames({})).toBe("暂无文件");
  });

  it("renders old single-file material shape", () => {
    expect(renderMaterialFileNames({ file: { originalName: "id_front.png" } })).toBe("id_front.png");
  });

  it("renders grouped multi-file material shape", () => {
    expect(
      renderMaterialFileNames({
        files: [{ fileName: "id_front.png" }, { fileName: "id_back.png" }]
      })
    ).toBe("id_front.png、id_back.png");
  });
});
