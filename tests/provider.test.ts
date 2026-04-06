import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createTracerProvider } from "../src/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchStub(ok = true): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
  } as Response);
}

const DEFAULT_ENDPOINT = "https://otel.example.com/v1/traces";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTracerProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // TracerProvider shape
  // -------------------------------------------------------------------------

  describe("TracerProvider shape", () => {
    it("returns an object with getTracer and forceFlush methods", () => {
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      expect(typeof provider.getTracer).toBe("function");
      expect(typeof provider.forceFlush).toBe("function");
    });

    it("getTracer returns a tracer with a startSpan method", () => {
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");

      expect(typeof tracer.startSpan).toBe("function");
    });

    it("forceFlush is a function returning a Promise", () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const result = provider.forceFlush();
      expect(result).toBeInstanceOf(Promise);
    });
  });

  // -------------------------------------------------------------------------
  // Instrumentation scope name
  // -------------------------------------------------------------------------

  describe("instrumentation scope name", () => {
    it("tracer scope name matches the provided scopeName argument", () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.instrumentationScope.name).toBe("ai");

      span.end();
    });

    it("getTracer uses the provided scopeName", () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("my-custom-scope");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.instrumentationScope.name).toBe("my-custom-scope");

      span.end();
    });
  });

  // -------------------------------------------------------------------------
  // Resource attributes
  // -------------------------------------------------------------------------

  describe("resource attributes", () => {
    it("uses 'cloudflare-worker' as the default service name", () => {
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.resource.attributes["service.name"]).toBe(
        "cloudflare-worker",
      );

      span.end();
    });

    it("uses the provided serviceName when specified", () => {
      const provider = createTracerProvider({
        endpoint: DEFAULT_ENDPOINT,
        serviceName: "my-custom-service",
      });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.resource.attributes["service.name"]).toBe(
        "my-custom-service",
      );

      span.end();
    });

    it("extra keys in resourceAttributes appear on the span resource", () => {
      const provider = createTracerProvider({
        endpoint: DEFAULT_ENDPOINT,
        resourceAttributes: { "deployment.environment.name": "production" },
      });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(
        readableSpan.resource.attributes["deployment.environment.name"],
      ).toBe("production");

      span.end();
    });

    it("resourceAttributes overrides serviceName when both supply service.name", () => {
      const provider = createTracerProvider({
        endpoint: DEFAULT_ENDPOINT,
        serviceName: "original",
        resourceAttributes: { "service.name": "override" },
      });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.resource.attributes["service.name"]).toBe("override");

      span.end();
    });
  });

  // -------------------------------------------------------------------------
  // forceFlush delegation
  // -------------------------------------------------------------------------

  describe("forceFlush delegation", () => {
    it("forceFlush() resolves to undefined", async () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      await expect(provider.forceFlush()).resolves.toBeUndefined();
    });

    it("forceFlush() triggers fetch after spans have been exported", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");
      const span = tracer.startSpan("exported-span");
      span.end(); // ending a span triggers SimpleSpanProcessor.onEnd → exporter.export()

      await provider.forceFlush();

      expect(fetchStub).toHaveBeenCalledOnce();
    });

    it("forceFlush() does not call fetch when no spans were created", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      await provider.forceFlush();

      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("forceFlush() resolves even when the exporter fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network error")),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");
      const span = tracer.startSpan("failing-span");
      span.end();

      await expect(provider.forceFlush()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
