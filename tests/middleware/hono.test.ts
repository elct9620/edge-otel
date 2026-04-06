import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { Hono } from "hono";
import { createHonoMiddleware } from "../../src/middleware/hono.js";
import type { TracerHandle } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHandle() {
  const mockSpan = {
    end: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
  };
  const mockCtx = {};
  const flushFn = vi.fn().mockResolvedValue(undefined);

  const handle: TracerHandle = {
    tracer: { startSpan: vi.fn() } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    flush: flushFn,
    rootSpan: vi.fn().mockReturnValue({ span: mockSpan, ctx: mockCtx }),
  };

  return { handle, mockSpan, mockCtx, flushFn };
}

function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as {
    waitUntil: ReturnType<typeof vi.fn>;
    passThroughOnException: ReturnType<typeof vi.fn>;
  };
}

function requestWith(
  app: Hono,
  path: string,
  executionCtx: ReturnType<typeof createExecutionCtx>,
) {
  // Hono.request(input, requestInit, Env, executionCtx)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.request(path, undefined, undefined, executionCtx as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHonoMiddleware", () => {
  let handle: TracerHandle;
  let mockSpan: ReturnType<typeof createMockHandle>["mockSpan"];
  let flushFn: ReturnType<typeof createMockHandle>["flushFn"];

  beforeEach(() => {
    const mocks = createMockHandle();
    handle = mocks.handle;
    mockSpan = mocks.mockSpan;
    flushFn = mocks.flushFn;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Root span creation
  // -------------------------------------------------------------------------

  describe("root span creation", () => {
    it("calls rootSpan with the default name 'http.request' when no options provided", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(handle.rootSpan).toHaveBeenCalledWith("http.request", undefined);
    });

    it("calls rootSpan with a custom span name when provided in options", async () => {
      const app = new Hono();
      app.use(
        "*",
        createHonoMiddleware(handle, { spanName: "my.custom.span" }),
      );
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(handle.rootSpan).toHaveBeenCalledWith("my.custom.span", undefined);
    });

    it("calls rootSpan with custom attributes when provided in options", async () => {
      const attributes = { "http.method": "GET", "service.version": "1.0.0" };
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle, { attributes }));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(handle.rootSpan).toHaveBeenCalledWith("http.request", attributes);
    });

    it("calls rootSpan with both custom name and attributes when both provided", async () => {
      const attributes = { "gen_ai.system": "openai" };
      const app = new Hono();
      app.use(
        "*",
        createHonoMiddleware(handle, { spanName: "ai.request", attributes }),
      );
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(handle.rootSpan).toHaveBeenCalledWith("ai.request", attributes);
    });
  });

  // -------------------------------------------------------------------------
  // Tracer exposed via Hono context
  // -------------------------------------------------------------------------

  describe("tracer exposure via Hono context", () => {
    it("sets the tracer on the Hono context so handlers can retrieve it", async () => {
      let capturedTracer: unknown;

      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capturedTracer = (c as any).get("tracer");
        return c.text("ok");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(capturedTracer).toBe(handle.tracer);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("calls span.recordException with the thrown error", async () => {
      const boom = new Error("something went wrong");

      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw boom;
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.recordException).toHaveBeenCalledWith(boom);
    });

    it("calls span.setStatus with ERROR code when handler throws", async () => {
      const boom = new Error("something went wrong");

      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw boom;
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: boom.message,
      });
    });

    it("results in a 500 response when the handler throws", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw new Error("crash");
      });

      const res = await requestWith(app, "/test", createExecutionCtx());

      expect(res.status).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // Span lifecycle
  // -------------------------------------------------------------------------

  describe("span lifecycle", () => {
    it("calls span.end on the success path", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("calls span.end even when the handler throws", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw new Error("crash");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("calls span.setStatus with OK on the success path", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.OK,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Flush registration
  // -------------------------------------------------------------------------

  describe("flush registration", () => {
    it("calls handle.flush() on the success path", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(flushFn).toHaveBeenCalledOnce();
    });

    it("calls handle.flush() even when the handler throws", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw new Error("crash");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(flushFn).toHaveBeenCalledOnce();
    });

    it("registers flush promise with waitUntil on the success path", async () => {
      const flushResult = Promise.resolve(undefined);
      flushFn.mockReturnValue(flushResult);

      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", (c) => c.text("ok"));

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      expect(executionCtx.waitUntil).toHaveBeenCalledWith(flushResult);
    });

    it("registers flush promise with waitUntil even when the handler throws", async () => {
      const flushResult = Promise.resolve(undefined);
      flushFn.mockReturnValue(flushResult);

      const app = new Hono();
      app.use("*", createHonoMiddleware(handle));
      app.get("/test", () => {
        throw new Error("crash");
      });

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      expect(executionCtx.waitUntil).toHaveBeenCalledWith(flushResult);
    });
  });
});
