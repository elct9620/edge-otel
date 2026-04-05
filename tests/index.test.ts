import { describe, it, expect } from "vitest";

describe("@aotoki/edge-otel", () => {
  it("should be importable", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeDefined();
  });
});
