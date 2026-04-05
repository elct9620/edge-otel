import { describe, it, expect, vi, afterEach } from "vitest";
import { context as otelContext, trace } from "@opentelemetry/api";
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
  // TracerHandle shape
  // -------------------------------------------------------------------------

  describe("TracerHandle shape", () => {
    it("returns an object with tracer, flush, and rootSpan properties", () => {
      const handle = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      expect(handle).toHaveProperty("tracer");
      expect(handle).toHaveProperty("flush");
      expect(handle).toHaveProperty("rootSpan");
    });

    it("tracer has a startSpan method", () => {
      const { tracer } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      expect(typeof tracer.startSpan).toBe("function");
    });

    it("flush is a function returning a Promise", () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const { flush } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      expect(typeof flush).toBe("function");
      const result = flush();
      expect(result).toBeInstanceOf(Promise);
    });

    it("rootSpan is a function", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      expect(typeof rootSpan).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // Instrumentation scope name
  // -------------------------------------------------------------------------

  describe("instrumentation scope name", () => {
    it("tracer scope name is exactly 'ai'", () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const { tracer } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      // Start and end a span to make it readable; the instrumentation scope
      // name is accessible directly on the ReadableSpan cast.
      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.instrumentationScope.name).toBe("ai");

      span.end();
    });
  });

  // -------------------------------------------------------------------------
  // Resource attributes
  // -------------------------------------------------------------------------

  describe("resource attributes", () => {
    it("uses 'cloudflare-worker' as the default service name", () => {
      const { tracer } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.resource.attributes["service.name"]).toBe(
        "cloudflare-worker",
      );

      span.end();
    });

    it("uses the provided serviceName when specified", () => {
      const { tracer } = createTracerProvider({
        endpoint: DEFAULT_ENDPOINT,
        serviceName: "my-custom-service",
      });

      const span = tracer.startSpan("probe");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.resource.attributes["service.name"]).toBe(
        "my-custom-service",
      );

      span.end();
    });
  });

  // -------------------------------------------------------------------------
  // rootSpan helper
  // -------------------------------------------------------------------------

  describe("rootSpan helper", () => {
    it("returns an object with span and ctx properties", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const result = rootSpan("test-span");
      expect(result).toHaveProperty("span");
      expect(result).toHaveProperty("ctx");

      result.span.end();
    });

    it("span has end and setAttribute methods", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const { span } = rootSpan("test-span");
      expect(typeof span.end).toBe("function");
      expect(typeof span.setAttribute).toBe("function");

      span.end();
    });

    it("ctx is a valid Context (span is retrievable from it)", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const { span, ctx } = rootSpan("test-span");
      const retrievedSpan = trace.getSpan(ctx);
      expect(retrievedSpan).toBe(span);

      span.end();
    });

    it("span name matches the provided name", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const { span } = rootSpan("my-root-span");
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.name).toBe("my-root-span");

      span.end();
    });

    it("custom attributes are set on the span", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const { span } = rootSpan("attributed-span", {
        "gen_ai.system": "openai",
        "http.method": "POST",
      });
      const readableSpan = span as unknown as ReadableSpan;
      expect(readableSpan.attributes["gen_ai.system"]).toBe("openai");
      expect(readableSpan.attributes["http.method"]).toBe("POST");

      span.end();
    });

    it("ctx is based on the currently active context", () => {
      const { rootSpan } = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      // The returned ctx must reflect the active context at call time.
      const activeBefore = otelContext.active();
      const { ctx } = rootSpan("ctx-check");
      // ctx must differ from the root active context only in the span attached
      expect(ctx).not.toBe(activeBefore);
    });
  });

  // -------------------------------------------------------------------------
  // flush delegation
  // -------------------------------------------------------------------------

  describe("flush delegation", () => {
    it("flush() resolves to undefined", async () => {
      vi.stubGlobal("fetch", makeFetchStub());
      const handle = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      await expect(handle.flush()).resolves.toBeUndefined();
    });

    it("flush() triggers fetch after spans have been exported", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const handle = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const { span } = handle.rootSpan("exported-span");
      span.end(); // ending a span triggers SimpleSpanProcessor.onEnd → exporter.export()

      await handle.flush();

      expect(fetchStub).toHaveBeenCalledOnce();
    });

    it("flush() does not call fetch when no spans were created", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const handle = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      await handle.flush();

      expect(fetchStub).not.toHaveBeenCalled();
    });
  });
});
