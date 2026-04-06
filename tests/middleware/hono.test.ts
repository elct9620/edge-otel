import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { Hono } from "hono";
import { createHonoMiddleware } from "../../src/middleware/hono.js";
import type { TracerProvider } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProvider() {
  const mockSpan = {
    end: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
  };

  const mockTracer = {
    startActiveSpan: vi
      .fn()
      .mockImplementation(
        (
          _name: string,
          _options: unknown,
          fn: (span: typeof mockSpan) => unknown,
        ) => fn(mockSpan),
      ),
  };

  const forceFlushFn = vi.fn().mockResolvedValue(undefined);

  const provider: TracerProvider = {
    getTracer: vi.fn().mockReturnValue(mockTracer),
    forceFlush: forceFlushFn,
  };

  return { provider, mockTracer, mockSpan, forceFlushFn };
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
  let provider: TracerProvider;
  let mockSpan: ReturnType<typeof createMockProvider>["mockSpan"];
  let forceFlushFn: ReturnType<typeof createMockProvider>["forceFlushFn"];

  beforeEach(() => {
    const mocks = createMockProvider();
    provider = mocks.provider;
    mockSpan = mocks.mockSpan;
    forceFlushFn = mocks.forceFlushFn;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Root span creation
  // -------------------------------------------------------------------------

  describe("root span creation", () => {
    it("calls startActiveSpan with the default name 'http.request' when no options provided", async () => {
      const { mockTracer } = createMockProvider();
      const localProvider: TracerProvider = {
        getTracer: vi.fn().mockReturnValue(mockTracer),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };

      const app = new Hono();
      app.use("*", createHonoMiddleware(localProvider));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        "http.request",
        { attributes: undefined },
        expect.any(Function),
      );
    });

    it("calls startActiveSpan with a custom span name when provided in options", async () => {
      const { mockTracer } = createMockProvider();
      const localProvider: TracerProvider = {
        getTracer: vi.fn().mockReturnValue(mockTracer),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };

      const app = new Hono();
      app.use(
        "*",
        createHonoMiddleware(localProvider, { spanName: "my.custom.span" }),
      );
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        "my.custom.span",
        { attributes: undefined },
        expect.any(Function),
      );
    });

    it("calls startActiveSpan with custom attributes when provided in options", async () => {
      const { mockTracer } = createMockProvider();
      const localProvider: TracerProvider = {
        getTracer: vi.fn().mockReturnValue(mockTracer),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };
      const attributes = { "http.method": "GET", "service.version": "1.0.0" };

      const app = new Hono();
      app.use("*", createHonoMiddleware(localProvider, { attributes }));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        "http.request",
        { attributes },
        expect.any(Function),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Provider scope name
  // -------------------------------------------------------------------------

  describe("provider scope name", () => {
    it("calls getTracer with the default scope name 'ai'", () => {
      createHonoMiddleware(provider);

      expect(provider.getTracer).toHaveBeenCalledWith("ai");
    });

    it("calls getTracer with a custom scope name when provided in options", () => {
      createHonoMiddleware(provider, { scopeName: "my-service" });

      expect(provider.getTracer).toHaveBeenCalledWith("my-service");
    });
  });

  // -------------------------------------------------------------------------
  // Tracer exposed via Hono context
  // -------------------------------------------------------------------------

  describe("tracer exposure via Hono context", () => {
    it("sets the tracer on the Hono context so handlers can retrieve it", async () => {
      let capturedTracer: unknown;

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capturedTracer = (c as any).get("tracer");
        return c.text("ok");
      });

      await requestWith(app, "/test", createExecutionCtx());

      // The tracer set on context is the one returned by provider.getTracer('ai')
      expect(capturedTracer).toBe(
        (provider.getTracer as ReturnType<typeof vi.fn>).mock.results[0].value,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("calls span.recordException with the thrown error", async () => {
      const boom = new Error("something went wrong");

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", () => {
        throw boom;
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.recordException).toHaveBeenCalledWith(boom);
    });

    it("calls span.setStatus with ERROR code when handler throws", async () => {
      const boom = new Error("something went wrong");

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
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
      app.use("*", createHonoMiddleware(provider));
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
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("calls span.end even when the handler throws", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", () => {
        throw new Error("crash");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("calls span.setStatus with OK on the success path", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
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
    it("calls provider.forceFlush() on the success path", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => c.text("ok"));

      await requestWith(app, "/test", createExecutionCtx());

      expect(forceFlushFn).toHaveBeenCalledOnce();
    });

    it("calls provider.forceFlush() even when the handler throws", async () => {
      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", () => {
        throw new Error("crash");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(forceFlushFn).toHaveBeenCalledOnce();
    });

    it("registers forceFlush promise with waitUntil on the success path", async () => {
      const flushResult = Promise.resolve(undefined);
      forceFlushFn.mockReturnValue(flushResult);

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => c.text("ok"));

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      expect(executionCtx.waitUntil).toHaveBeenCalledWith(flushResult);
    });

    it("registers forceFlush promise with waitUntil even when the handler throws", async () => {
      const flushResult = Promise.resolve(undefined);
      forceFlushFn.mockReturnValue(flushResult);

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", () => {
        throw new Error("crash");
      });

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      expect(executionCtx.waitUntil).toHaveBeenCalledWith(flushResult);
    });
  });

  // -------------------------------------------------------------------------
  // deferFlush
  // -------------------------------------------------------------------------

  describe("deferFlush", () => {
    it("exposes deferFlush function via Hono context before calling next()", async () => {
      let capturedDeferFlush: unknown;

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capturedDeferFlush = (c as any).get("deferFlush");
        return c.text("ok");
      });

      await requestWith(app, "/test", createExecutionCtx());

      expect(capturedDeferFlush).toBeTypeOf("function");
    });

    it("chains forceFlush after the deferred promise when deferFlush is called", async () => {
      let resolveDeferredStream!: () => void;
      const deferredStream = new Promise<void>((resolve) => {
        resolveDeferredStream = resolve;
      });

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).get("deferFlush")(deferredStream);
        return c.text("ok");
      });

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      // forceFlush should not have been called yet — it's chained after the deferred promise
      expect(forceFlushFn).not.toHaveBeenCalled();

      // The promise passed to waitUntil should resolve only after the stream resolves
      resolveDeferredStream();
      // Flush the microtask queue so the .then() chain executes
      await Promise.resolve();
      await Promise.resolve();

      expect(forceFlushFn).toHaveBeenCalledOnce();
    });

    it("uses the last registered promise when deferFlush is called multiple times", async () => {
      let resolveSecond!: () => void;
      const firstPromise = Promise.resolve();
      const secondPromise = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deferFlush = (c as any).get("deferFlush");
        deferFlush(firstPromise);
        deferFlush(secondPromise);
        return c.text("ok");
      });

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      // forceFlush not yet called — waiting on secondPromise
      expect(forceFlushFn).not.toHaveBeenCalled();

      resolveSecond();
      await Promise.resolve();
      await Promise.resolve();

      expect(forceFlushFn).toHaveBeenCalledOnce();
    });

    it("flushes immediately (no deferred promise) when deferFlush is never called", async () => {
      const flushResult = Promise.resolve(undefined);
      forceFlushFn.mockReturnValue(flushResult);

      const app = new Hono();
      app.use("*", createHonoMiddleware(provider));
      app.get("/test", (c) => c.text("ok"));

      const executionCtx = createExecutionCtx();
      await requestWith(app, "/test", executionCtx);

      expect(executionCtx.waitUntil).toHaveBeenCalledWith(flushResult);
    });
  });
});
