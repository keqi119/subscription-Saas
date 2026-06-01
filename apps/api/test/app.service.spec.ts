import { describe, expect, it } from "vitest";

import { AppService } from "../src/app.service";

describe("AppService", () => {
  it("returns a healthy API status", () => {
    const health = new AppService().getHealth();

    expect(health.service).toBe("subscription-saas-api");
    expect(health.status).toBe("ok");
    expect(health.storage).toBe("local");
    expect(new Date(health.timestamp).toString()).not.toBe("Invalid Date");
  });
});
