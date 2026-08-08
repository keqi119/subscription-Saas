import { describe, expect, it } from "vitest";

import { normalizeUploadFilename } from "../src/upload/upload-filename";

describe("normalizeUploadFilename", () => {
  it("keeps a readable Chinese basename while removing client paths and controls", () => {
    expect(normalizeUploadFilename("C:\\fakepath\\车辆行驶证.pdf\u0000")).toBe("车辆行驶证.pdf");
  });

  it("keeps the extension while bounding a long filename", () => {
    const result = normalizeUploadFilename(`${"车".repeat(300)}.pdf`);

    expect(result.endsWith(".pdf")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(255);
  });

  it("uses a safe fallback when the basename becomes empty", () => {
    expect(normalizeUploadFilename("C:\\fakepath\\\u0000", "upload")).toBe("upload");
  });
});
