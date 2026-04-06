/**
 * Integration test — full request lifecycle end-to-end
 *
 * Validates the entire stack: provider → exporter → serializer → fetch POST,
 * with the Hono middleware managing root span lifecycle and context propagation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { context as otelContext, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { createTracerProvider } from "../src/index.js";
import { createHonoMiddleware } from "../src/middleware/hono.js";
import { langfuseExporter } from "../src/exporters/langfuse.js";
import type { ExportTraceServiceRequest } from "../src/serializer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://otel.example.com/v1/traces";

/** Intercepts fetch and captures all call arguments. */
function createFetchCaptor() {
  const calls: { url: string; init: RequestInit }[] = [];
  const mockFetch = vi
    .fn()
    .mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  return { mockFetch, calls };
}

/** Parses the OTLP JSON body from a captured fetch call. */
function parseOtlpBody(call: { init: RequestInit }): ExportTraceServiceRequest {
  return JSON.parse(call.init.body as string);
}

/**
 * Returns a minimal executionCtx compatible with Hono's type expectations.
 * Captures the promise passed to waitUntil so tests can await it.
 */
function createExecutionCtx() {
  let waitUntilPromise: Promise<unknown> | undefined;
  const ctx = {
    waitUntil: vi.fn().mockImplementation((p: Promise<unknown>) => {
      waitUntilPromise = p;
    }),
    passThroughOnException: vi.fn(),
  };
  return {
    ctx,
    getWaitUntilPromise: () => waitUntilPromise,
  };
}

/** Helper that calls app.request with the 4th-arg executionCtx override. */
function requestWith(
  app: Hono,
  path: string,
  executionCtx: ReturnType<typeof createExecutionCtx>["ctx"],
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.request(path, undefined, undefined, executionCtx as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration — full request lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Single request with Hono middleware produces correct OTLP payload
  // -------------------------------------------------------------------------

  describe("Scenario 1: single request produces correct OTLP payload", () => {
    it("POSTs exactly one OTLP request containing root + child spans with correct structure", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const provider = createTracerProvider({
        endpoint: DEFAULT_ENDPOINT,
        serviceName: "integration-test",
      });

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => {
        const tracer = provider.getTracer("ai");
        // Create a child span inside the active root context
        const child = tracer.startSpan("child-operation");
        child.setAttribute("custom.key", "custom-value");
        child.end();
        return c.text("ok");
      });

      const { ctx, getWaitUntilPromise } = createExecutionCtx();
      await requestWith(app, "/test", ctx);

      // Flush is registered via waitUntil — await it to complete the POST
      await getWaitUntilPromise();

      // Exactly one fetch POST should have been made
      expect(mockFetch).toHaveBeenCalledOnce();

      const otlp = parseOtlpBody(calls[0]);

      // Resource carries service.name
      const resourceAttrs = otlp.resourceSpans[0].resource.attributes;
      const serviceNameAttr = resourceAttrs.find(
        (a) => a.key === "service.name",
      );
      expect(serviceNameAttr).toBeDefined();
      expect(serviceNameAttr?.value.stringValue).toBe("integration-test");

      // Instrumentation scope is 'ai'
      expect(otlp.resourceSpans[0].scopeSpans[0].scope.name).toBe("ai");

      // At least 2 spans: root HTTP request + child-operation
      const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
      expect(spans.length).toBeGreaterThanOrEqual(2);

      // All spans share the same traceId
      const traceIds = spans.map((s) => s.traceId);
      expect(new Set(traceIds).size).toBe(1);

      // Identify root span (no parentSpanId) and child span
      const rootSpan = spans.find((s) => s.parentSpanId === undefined);
      const childSpan = spans.find((s) => s.name === "child-operation");
      expect(rootSpan).toBeDefined();
      expect(childSpan).toBeDefined();

      // Root span must not have parentSpanId at all — not even as empty string
      expect(
        Object.prototype.hasOwnProperty.call(rootSpan, "parentSpanId"),
      ).toBe(false);

      // Child span's parentSpanId must equal root span's spanId
      expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId);

      // Timestamps are strings, not numbers
      expect(typeof rootSpan?.startTimeUnixNano).toBe("string");
      expect(typeof rootSpan?.endTimeUnixNano).toBe("string");
      expect(rootSpan?.startTimeUnixNano.length).toBeGreaterThan(0);
      expect(rootSpan?.endTimeUnixNano.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Multiple child spans share the same traceId
  // -------------------------------------------------------------------------

  describe("Scenario 2: multiple child spans share traceId", () => {
    it("all child spans are parented to the root span and share one traceId", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/multi", (c) => {
        // Simulate 3 sequential AI SDK-like calls
        for (let i = 0; i < 3; i++) {
          const span = tracer.startSpan(`ai.call.${i}`);
          span.end();
        }
        return c.text("ok");
      });

      const { ctx, getWaitUntilPromise } = createExecutionCtx();
      await requestWith(app, "/multi", ctx);
      await getWaitUntilPromise();

      expect(mockFetch).toHaveBeenCalledOnce();
      const otlp = parseOtlpBody(calls[0]);
      const spans = otlp.resourceSpans[0].scopeSpans[0].spans;

      // 1 root + 3 children = 4 spans
      expect(spans.length).toBeGreaterThanOrEqual(4);

      // All spans share the same traceId
      const traceIds = new Set(spans.map((s) => s.traceId));
      expect(traceIds.size).toBe(1);

      // Each child span has a parentSpanId pointing to the root span
      const rootSpan = spans.find((s) => s.parentSpanId === undefined);
      expect(rootSpan).toBeDefined();

      const childSpans = spans.filter((s) => s.name.startsWith("ai.call."));
      expect(childSpans).toHaveLength(3);
      for (const child of childSpans) {
        expect(child.parentSpanId).toBe(rootSpan?.spanId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Error in handler produces ERROR status span
  // -------------------------------------------------------------------------

  describe("Scenario 3: handler error produces ERROR status span", () => {
    it("root span has status code 2 (ERROR) and records an exception event", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      vi.spyOn(console, "error").mockImplementation(() => {});
      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/boom", () => {
        throw new Error("something went wrong");
      });

      const { ctx, getWaitUntilPromise } = createExecutionCtx();
      await requestWith(app, "/boom", ctx);
      await getWaitUntilPromise();

      expect(mockFetch).toHaveBeenCalledOnce();
      const otlp = parseOtlpBody(calls[0]);
      const spans = otlp.resourceSpans[0].scopeSpans[0].spans;

      // Root span is the one without a parent
      const rootSpan = spans.find((s) => s.parentSpanId === undefined);
      expect(rootSpan).toBeDefined();

      // Status code 2 = ERROR
      expect(rootSpan?.status.code).toBe(2);

      // An exception event must be recorded on the root span
      const exceptionEvent = rootSpan?.events.find(
        (e) => e.name === "exception",
      );
      expect(exceptionEvent).toBeDefined();

      // The event must carry exception.message
      const messageAttr = exceptionEvent?.attributes.find(
        (a) => a.key === "exception.message",
      );
      expect(messageAttr).toBeDefined();
      expect(messageAttr?.value.stringValue).toBe("something went wrong");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Langfuse preset produces correct endpoint and headers
  // -------------------------------------------------------------------------

  describe("Scenario 4: Langfuse preset wires correct endpoint and headers", () => {
    it("fetch is called with the Langfuse OTLP URL and required headers", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const config = langfuseExporter({
        publicKey: "pk-test",
        secretKey: "sk-test",
      });

      const provider = createTracerProvider(config);
      const tracer = provider.getTracer("ai");

      // Create and end a span to populate the buffer
      const span = tracer.startSpan("langfuse-probe");
      const spanCtx = trace.setSpan(otelContext.active(), span);
      await otelContext.with(spanCtx, async () => {
        span.end();
      });

      await provider.forceFlush();

      expect(mockFetch).toHaveBeenCalledOnce();

      const { url, init } = calls[0];

      // Full Langfuse OTLP endpoint
      expect(url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");

      const headers = init.headers as Record<string, string>;

      // Basic auth header
      expect(headers["Authorization"]).toBe(`Basic ${btoa("pk-test:sk-test")}`);

      // Langfuse-specific ingestion version header
      expect(headers["x-langfuse-ingestion-version"]).toBe("4");

      // Content-Type must always be present
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Langfuse environment and release flow through as resource attributes
  // -------------------------------------------------------------------------

  describe("Scenario 5: Langfuse environment and release appear as resource attributes", () => {
    it("resourceSpans[0].resource.attributes contains deployment.environment.name and service.version", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const config = langfuseExporter({
        publicKey: "pk-test",
        secretKey: "sk-test",
        environment: "production",
        release: "1.0.0",
      });

      const provider = createTracerProvider(config);
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("env-release-probe");
      const spanCtx = trace.setSpan(otelContext.active(), span);
      await otelContext.with(spanCtx, async () => {
        span.end();
      });

      await provider.forceFlush();

      expect(mockFetch).toHaveBeenCalledOnce();

      const otlp = parseOtlpBody(calls[0]);
      const resourceAttrs = otlp.resourceSpans[0].resource.attributes;

      const envAttr = resourceAttrs.find(
        (a) => a.key === "deployment.environment.name",
      );
      expect(envAttr).toBeDefined();
      expect(envAttr?.value.stringValue).toBe("production");

      const versionAttr = resourceAttrs.find(
        (a) => a.key === "service.version",
      );
      expect(versionAttr).toBeDefined();
      expect(versionAttr?.value.stringValue).toBe("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Empty flush does not call fetch
  // -------------------------------------------------------------------------

  describe("Scenario 6: empty flush skips fetch", () => {
    it("does not call fetch when no spans have been created", async () => {
      const { mockFetch } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });

      // Flush immediately without creating any spans
      await provider.forceFlush();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Attribute type fidelity in OTLP payload
  // -------------------------------------------------------------------------

  describe("Scenario 7: attribute type fidelity in OTLP payload", () => {
    it("encodes string, integer, float, and boolean attributes with correct OTLP value wrappers", async () => {
      const { mockFetch, calls } = createFetchCaptor();
      vi.stubGlobal("fetch", mockFetch);

      const provider = createTracerProvider({ endpoint: DEFAULT_ENDPOINT });
      const tracer = provider.getTracer("ai");

      const span = tracer.startSpan("attribute-fidelity");
      const spanCtx = trace.setSpan(otelContext.active(), span);
      await otelContext.with(spanCtx, async () => {
        span.setAttribute("str.attr", "hello");
        span.setAttribute("int.attr", 42);
        span.setAttribute("float.attr", 3.14);
        span.setAttribute("bool.attr", true);
        span.end();
      });

      await provider.forceFlush();

      expect(mockFetch).toHaveBeenCalledOnce();
      const otlp = parseOtlpBody(calls[0]);
      const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
      const testSpan = spans.find((s) => s.name === "attribute-fidelity");
      expect(testSpan).toBeDefined();

      const attrs = testSpan!.attributes;

      const strAttr = attrs.find((a) => a.key === "str.attr");
      expect(strAttr?.value).toEqual({ stringValue: "hello" });

      // intValue must be a decimal string, not a JS number
      const intAttr = attrs.find((a) => a.key === "int.attr");
      expect(intAttr?.value).toEqual({ intValue: "42" });
      expect(typeof intAttr?.value.intValue).toBe("string");

      // doubleValue must be a JS number
      const floatAttr = attrs.find((a) => a.key === "float.attr");
      expect(floatAttr?.value).toEqual({ doubleValue: 3.14 });
      expect(typeof floatAttr?.value.doubleValue).toBe("number");

      // boolValue must be a JS boolean
      const boolAttr = attrs.find((a) => a.key === "bool.attr");
      expect(boolAttr?.value).toEqual({ boolValue: true });
      expect(typeof boolAttr?.value.boolValue).toBe("boolean");
    });
  });
});
