import { describe, it, expect, vi, afterEach } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import { OtlpHttpJsonExporter } from "../src/exporters/http.js";
import { createMockSpan } from "./helpers/mock-span.js";

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

describe("OtlpHttpJsonExporter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Buffer accumulation
  // -------------------------------------------------------------------------

  describe("buffer accumulation", () => {
    it("calls resultCallback with SUCCESS when export() is called", () => {
      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      const span = createMockSpan();

      let result: { code: number } | undefined;
      exporter.export([span], (r) => {
        result = r;
      });

      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    });

    it("accumulates spans across multiple export() calls", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      const span1 = createMockSpan({
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000001",
          traceFlags: 1,
          isRemote: false,
        }),
      });
      const span2 = createMockSpan({
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000002",
          traceFlags: 1,
          isRemote: false,
        }),
      });

      exporter.export([span1], () => {});
      exporter.export([span2], () => {});

      await exporter.forceFlush();

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = JSON.parse(
        (fetchStub.mock.calls[0][1] as RequestInit).body as string,
      );
      const spans = body.resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(2);
    });

    it("returns SUCCESS for each individual export() call", () => {
      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      const results: number[] = [];

      exporter.export([createMockSpan()], (r) => results.push(r.code));
      exporter.export([createMockSpan()], (r) => results.push(r.code));
      exporter.export([createMockSpan()], (r) => results.push(r.code));

      expect(results).toEqual([
        ExportResultCode.SUCCESS,
        ExportResultCode.SUCCESS,
        ExportResultCode.SUCCESS,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Atomic flush
  // -------------------------------------------------------------------------

  describe("atomic flush", () => {
    it("POSTs serialized spans to the configured endpoint on forceFlush()", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      expect(fetchStub).toHaveBeenCalledOnce();
      expect(fetchStub.mock.calls[0][0]).toBe(DEFAULT_ENDPOINT);
    });

    it("sends POST method", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
    });

    it("sets Content-Type: application/json header", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("sends a valid JSON body containing serialized spans", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body).toHaveProperty("resourceSpans");
      expect(body.resourceSpans).toHaveLength(1);
    });

    it("drains the buffer atomically — second flush does nothing", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();
      await exporter.forceFlush(); // second flush — buffer already empty

      expect(fetchStub).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Empty buffer skip
  // -------------------------------------------------------------------------

  describe("empty buffer skip", () => {
    it("resolves immediately without calling fetch when buffer is empty", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown behavior
  // -------------------------------------------------------------------------

  describe("shutdown behavior", () => {
    it("flushes buffered spans before marking as shut down", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.shutdown();

      expect(fetchStub).toHaveBeenCalledOnce();
    });

    it("calls resultCallback with FAILED after shutdown", async () => {
      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      await exporter.shutdown();

      let result: { code: number } | undefined;
      exporter.export([createMockSpan()], (r) => {
        result = r;
      });

      expect(result).toEqual({ code: ExportResultCode.FAILED });
    });

    it("does not call fetch for export() calls made after shutdown", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      await exporter.shutdown();

      // export after shutdown — spans must not be buffered or flushed
      exporter.export([createMockSpan()], () => {});
      await exporter.forceFlush();

      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("resolves (never rejects) when fetch throws a network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network error")),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    });

    it("calls console.warn when fetch throws", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network error")),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});
      await exporter.forceFlush();

      expect(warnSpy).toHaveBeenCalledWith(
        "[edge-otel] span export failed:",
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });

    it("calls console.warn when fetch returns non-2xx response (e.g., 500)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as Response),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});
      await exporter.forceFlush();

      expect(warnSpy).toHaveBeenCalledWith(
        "[edge-otel] span export failed:",
        500,
        "Internal Server Error",
      );

      warnSpy.mockRestore();
    });

    it("calls console.warn when fetch returns 401 unauthorized", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
        } as Response),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});
      await exporter.forceFlush();

      expect(warnSpy).toHaveBeenCalledWith(
        "[edge-otel] span export failed:",
        401,
        "Unauthorized",
      );

      warnSpy.mockRestore();
    });

    it("resolves (never rejects) when fetch returns non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as Response),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    });

    it("drops spans from a failed flush (buffer is empty after failed flush)", async () => {
      const fetchStub = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error")) // first flush fails
        .mockResolvedValue({ ok: true, status: 200 } as Response); // second succeeds
      vi.stubGlobal("fetch", fetchStub);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush(); // fails — spans are dropped

      await exporter.forceFlush(); // second flush on an empty buffer

      // fetch is called exactly once (for the failed attempt); not again
      expect(fetchStub).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Headers
  // -------------------------------------------------------------------------

  describe("headers", () => {
    it("passes custom headers from config to fetch", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({
        endpoint: DEFAULT_ENDPOINT,
        headers: {
          Authorization: "Bearer secret-token",
          "X-Custom-Header": "my-value",
        },
      });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-token");
      expect(headers["X-Custom-Header"]).toBe("my-value");
    });

    it("always includes Content-Type even when custom headers are provided", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({
        endpoint: DEFAULT_ENDPOINT,
        headers: { Authorization: "Bearer token" },
      });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("works correctly with no headers configured", async () => {
      const fetchStub = makeFetchStub();
      vi.stubGlobal("fetch", fetchStub);

      const exporter = new OtlpHttpJsonExporter({ endpoint: DEFAULT_ENDPOINT });
      exporter.export([createMockSpan()], () => {});

      await exporter.forceFlush();

      const init = fetchStub.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBeUndefined();
    });
  });
});
