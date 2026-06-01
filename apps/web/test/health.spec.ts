import { describe, expect, it } from "vitest";

import { getStatusTone } from "../src/lib/health";

describe("getStatusTone", () => {
  it("maps service status to UI tone", () => {
    expect(getStatusTone("ok")).toBe("success");
    expect(getStatusTone("degraded")).toBe("warning");
    expect(getStatusTone("down")).toBe("error");
  });
});
