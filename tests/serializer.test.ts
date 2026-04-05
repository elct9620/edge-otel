import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { serializeSpans } from "../src/serializer.js";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockSpan(overrides?: Record<string, unknown>): ReadableSpan {
  const base = {
    name: "test-span",
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "6b2fb682896f0001",
      traceFlags: 1,
      isRemote: false,
    }),
    parentSpanContext: undefined,
    startTime: [1700000000, 0] as [number, number],
    endTime: [1700000001, 0] as [number, number],
    duration: [1, 0] as [number, number],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    ended: true,
    resource: {
      attributes: { "service.name": "test-service" },
      merge: () => null,
      getRawAttributes: () => [],
    },
    instrumentationScope: { name: "ai" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };

  return { ...base, ...overrides } as unknown as ReadableSpan;
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("serializeSpans", () => {
  describe("empty input", () => {
    it("returns resourceSpans: [] for an empty span array", () => {
      expect(serializeSpans([])).toEqual({ resourceSpans: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Timestamp encoding
  // -------------------------------------------------------------------------

  describe("timestamp encoding", () => {
    it("encodes startTime as a nanosecond decimal string via string concatenation", () => {
      const span = createMockSpan({ startTime: [1700000000, 123456789] });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.startTimeUnixNano).toBe("1700000000123456789");
      expect(typeof otlpSpan.startTimeUnixNano).toBe("string");
    });

    it("encodes endTime as a nanosecond decimal string via string concatenation", () => {
      const span = createMockSpan({ endTime: [1700000001, 987654321] });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.endTimeUnixNano).toBe("1700000001987654321");
      expect(typeof otlpSpan.endTimeUnixNano).toBe("string");
    });

    it("pads nanoseconds with leading zeros to 9 digits", () => {
      // 1000 nanoseconds must be padded to 000001000
      const span = createMockSpan({ startTime: [1700000000, 1000] });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.startTimeUnixNano).toBe("1700000000000001000");
    });

    it("handles zero nanoseconds (all nine zeros)", () => {
      const span = createMockSpan({ startTime: [1700000000, 0] });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.startTimeUnixNano).toBe("1700000000000000000");
    });

    it("avoids MAX_SAFE_INTEGER overflow for large second values", () => {
      // 9007199254 seconds * 1e9 would exceed Number.MAX_SAFE_INTEGER if done
      // arithmetically; string concatenation must produce the correct result
      const span = createMockSpan({ startTime: [9007199254, 999999999] });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.startTimeUnixNano).toBe("9007199254999999999");
      expect(typeof otlpSpan.startTimeUnixNano).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // Attribute type mapping
  // -------------------------------------------------------------------------

  describe("attribute type mapping", () => {
    it("maps string attributes to { stringValue }", () => {
      const span = createMockSpan({ attributes: { key: "hello" } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "key",
        value: { stringValue: "hello" },
      });
    });

    it("maps integer attributes to { intValue } as a decimal string (NOT number)", () => {
      const span = createMockSpan({ attributes: { count: 42 } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      const attr = attrs.find((a) => a.key === "count");
      expect(attr).toBeDefined();
      expect(attr!.value).toEqual({ intValue: "42" });
      expect(typeof attr!.value.intValue).toBe("string");
    });

    it("maps float attributes to { doubleValue } as a number", () => {
      const span = createMockSpan({ attributes: { ratio: 3.14 } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "ratio",
        value: { doubleValue: 3.14 },
      });
    });

    it("maps boolean attributes to { boolValue }", () => {
      const span = createMockSpan({ attributes: { active: true } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "active",
        value: { boolValue: true },
      });
    });

    it("maps boolean false attributes to { boolValue: false }", () => {
      const span = createMockSpan({ attributes: { active: false } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "active",
        value: { boolValue: false },
      });
    });

    it("maps array attributes to { arrayValue: { values: [...] } }", () => {
      const span = createMockSpan({ attributes: { tags: ["a", "b"] } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "tags",
        value: {
          arrayValue: {
            values: [{ stringValue: "a" }, { stringValue: "b" }],
          },
        },
      });
    });

    it("maps mixed-type arrays correctly", () => {
      const span = createMockSpan({ attributes: { mixed: [1, "x", true] } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      const attr = attrs.find((a) => a.key === "mixed");

      expect(attr!.value.arrayValue!.values).toEqual([
        { intValue: "1" },
        { stringValue: "x" },
        { boolValue: true },
      ]);
    });

    it("maps null attribute value to { stringValue: 'null' } via fallback", () => {
      // null is not a recognised OtlpAnyValue variant; the fallback coerces via String()
      const span = createMockSpan({ attributes: { nullable: null } });
      const result = serializeSpans([span]);
      const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes;

      expect(attrs).toContainEqual({
        key: "nullable",
        value: { stringValue: "null" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Root vs child spans
  // -------------------------------------------------------------------------

  describe("root vs child spans", () => {
    it("omits parentSpanId entirely for a root span (undefined parentSpanContext)", () => {
      const span = createMockSpan({ parentSpanContext: undefined });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(
        Object.prototype.hasOwnProperty.call(otlpSpan, "parentSpanId"),
      ).toBe(false);
    });

    it("omits parentSpanId when parentSpanContext has an empty spanId", () => {
      const span = createMockSpan({
        parentSpanContext: {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "",
          traceFlags: 1,
        },
      });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(
        Object.prototype.hasOwnProperty.call(otlpSpan, "parentSpanId"),
      ).toBe(false);
    });

    it("includes parentSpanId for a child span with a valid parentSpanContext", () => {
      const parentId = "aabbccddeeff0011";
      const span = createMockSpan({
        parentSpanContext: {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: parentId,
          traceFlags: 1,
        },
      });
      const result = serializeSpans([span]);
      const otlpSpan = result.resourceSpans[0].scopeSpans[0].spans[0];

      expect(otlpSpan.parentSpanId).toBe(parentId);
    });
  });

  // -------------------------------------------------------------------------
  // Span kind mapping
  // -------------------------------------------------------------------------

  describe("span kind mapping", () => {
    const cases: Array<[string, SpanKind, number]> = [
      ["INTERNAL (0) → OTLP kind 1", SpanKind.INTERNAL, 1],
      ["SERVER  (1) → OTLP kind 2", SpanKind.SERVER, 2],
      ["CLIENT  (2) → OTLP kind 3", SpanKind.CLIENT, 3],
      ["PRODUCER(3) → OTLP kind 4", SpanKind.PRODUCER, 4],
      ["CONSUMER(4) → OTLP kind 5", SpanKind.CONSUMER, 5],
    ];

    for (const [label, sdkKind, otlpKind] of cases) {
      it(`maps ${label}`, () => {
        const span = createMockSpan({ kind: sdkKind });
        const result = serializeSpans([span]);
        expect(result.resourceSpans[0].scopeSpans[0].spans[0].kind).toBe(
          otlpKind,
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe("events", () => {
    it("serializes span events with name, nanosecond time string, and attributes", () => {
      const span = createMockSpan({
        events: [
          {
            name: "exception",
            time: [1700000000, 500000000],
            attributes: { "exception.type": "Error" },
          },
        ],
      });
      const result = serializeSpans([span]);
      const events = result.resourceSpans[0].scopeSpans[0].spans[0].events;

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("exception");
      expect(events[0].timeUnixNano).toBe("1700000000500000000");
      expect(typeof events[0].timeUnixNano).toBe("string");
      expect(events[0].attributes).toContainEqual({
        key: "exception.type",
        value: { stringValue: "Error" },
      });
    });

    it("serializes events with no attributes as empty array", () => {
      const span = createMockSpan({
        events: [{ name: "checkpoint", time: [1700000000, 0] }],
      });
      const result = serializeSpans([span]);
      const events = result.resourceSpans[0].scopeSpans[0].spans[0].events;

      expect(events[0].attributes).toEqual([]);
    });

    it("propagates droppedAttributesCount from event", () => {
      const span = createMockSpan({
        events: [
          {
            name: "overflow",
            time: [1700000000, 0],
            droppedAttributesCount: 3,
          },
        ],
      });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].events[0]
          .droppedAttributesCount,
      ).toBe(3);
    });

    it("defaults droppedAttributesCount to 0 when not provided on event", () => {
      const span = createMockSpan({
        events: [{ name: "ok", time: [1700000000, 0] }],
      });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].events[0]
          .droppedAttributesCount,
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("serializes UNSET status code", () => {
      const span = createMockSpan({ status: { code: SpanStatusCode.UNSET } });
      const result = serializeSpans([span]);
      expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(
        SpanStatusCode.UNSET,
      );
    });

    it("serializes OK status code", () => {
      const span = createMockSpan({ status: { code: SpanStatusCode.OK } });
      const result = serializeSpans([span]);
      expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(
        SpanStatusCode.OK,
      );
    });

    it("serializes ERROR status code", () => {
      const span = createMockSpan({ status: { code: SpanStatusCode.ERROR } });
      const result = serializeSpans([span]);
      expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(
        SpanStatusCode.ERROR,
      );
    });

    it("includes status message when defined", () => {
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR, message: "something went wrong" },
      });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].status.message,
      ).toBe("something went wrong");
    });

    it("omits status message when undefined", () => {
      const span = createMockSpan({ status: { code: SpanStatusCode.UNSET } });
      const result = serializeSpans([span]);
      const status = result.resourceSpans[0].scopeSpans[0].spans[0].status;

      expect(Object.prototype.hasOwnProperty.call(status, "message")).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Resource & scope grouping
  // -------------------------------------------------------------------------

  describe("resource and scope grouping", () => {
    it("groups spans with the same resource under one resourceSpans entry", () => {
      const sharedResource = { attributes: { "service.name": "my-service" } };
      const span1 = createMockSpan({
        resource: sharedResource,
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000001",
          traceFlags: 1,
          isRemote: false,
        }),
      });
      const span2 = createMockSpan({
        resource: sharedResource,
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000002",
          traceFlags: 1,
          isRemote: false,
        }),
      });

      const result = serializeSpans([span1, span2]);

      expect(result.resourceSpans).toHaveLength(1);
      expect(result.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    });

    it("creates separate resourceSpans for spans with different resources", () => {
      const span1 = createMockSpan({
        resource: { attributes: { "service.name": "service-a" } },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000001",
          traceFlags: 1,
          isRemote: false,
        }),
      });
      const span2 = createMockSpan({
        resource: { attributes: { "service.name": "service-b" } },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "aaaa000000000002",
          traceFlags: 1,
          isRemote: false,
        }),
      });

      const result = serializeSpans([span1, span2]);

      expect(result.resourceSpans).toHaveLength(2);
    });

    it("groups spans with the same instrumentation scope under one scopeSpans entry", () => {
      const sharedResource = { attributes: { "service.name": "svc" } };
      const span1 = createMockSpan({
        resource: sharedResource,
        instrumentationScope: { name: "ai", version: "1.0.0" },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "bbbb000000000001",
          traceFlags: 1,
          isRemote: false,
        }),
      });
      const span2 = createMockSpan({
        resource: sharedResource,
        instrumentationScope: { name: "ai", version: "1.0.0" },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "bbbb000000000002",
          traceFlags: 1,
          isRemote: false,
        }),
      });

      const result = serializeSpans([span1, span2]);

      expect(result.resourceSpans[0].scopeSpans).toHaveLength(1);
      expect(result.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    });

    it("creates separate scopeSpans entries for different instrumentation scopes", () => {
      const sharedResource = { attributes: { "service.name": "svc" } };
      const span1 = createMockSpan({
        resource: sharedResource,
        instrumentationScope: { name: "ai" },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "cccc000000000001",
          traceFlags: 1,
          isRemote: false,
        }),
      });
      const span2 = createMockSpan({
        resource: sharedResource,
        instrumentationScope: { name: "http" },
        spanContext: () => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "cccc000000000002",
          traceFlags: 1,
          isRemote: false,
        }),
      });

      const result = serializeSpans([span1, span2]);

      expect(result.resourceSpans[0].scopeSpans).toHaveLength(2);
    });

    it("preserves the instrumentation scope name in output", () => {
      const span = createMockSpan({ instrumentationScope: { name: "ai" } });
      const result = serializeSpans([span]);

      expect(result.resourceSpans[0].scopeSpans[0].scope.name).toBe("ai");
    });

    it("includes scope version when defined and non-empty", () => {
      const span = createMockSpan({
        instrumentationScope: { name: "ai", version: "2.0.0" },
      });
      const result = serializeSpans([span]);

      expect(result.resourceSpans[0].scopeSpans[0].scope.version).toBe("2.0.0");
    });

    it("omits scope version when undefined", () => {
      const span = createMockSpan({
        instrumentationScope: { name: "ai", version: undefined },
      });
      const result = serializeSpans([span]);
      const scope = result.resourceSpans[0].scopeSpans[0].scope;

      expect(Object.prototype.hasOwnProperty.call(scope, "version")).toBe(
        false,
      );
    });

    it("omits scope version when empty string", () => {
      const span = createMockSpan({
        instrumentationScope: { name: "ai", version: "" },
      });
      const result = serializeSpans([span]);
      const scope = result.resourceSpans[0].scopeSpans[0].scope;

      expect(Object.prototype.hasOwnProperty.call(scope, "version")).toBe(
        false,
      );
    });

    it("serializes resource attributes as OtlpKeyValue[]", () => {
      const span = createMockSpan({
        resource: {
          attributes: { "service.name": "svc", "service.version": 3 },
          merge: () => null,
          getRawAttributes: () => [],
        },
      });
      const result = serializeSpans([span]);
      const resourceAttrs = result.resourceSpans[0].resource.attributes;

      expect(resourceAttrs).toContainEqual({
        key: "service.name",
        value: { stringValue: "svc" },
      });
      expect(resourceAttrs).toContainEqual({
        key: "service.version",
        value: { intValue: "3" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Dropped counts
  // -------------------------------------------------------------------------

  describe("dropped counts", () => {
    it("propagates droppedAttributesCount from span", () => {
      const span = createMockSpan({ droppedAttributesCount: 5 });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].droppedAttributesCount,
      ).toBe(5);
    });

    it("propagates droppedEventsCount from span", () => {
      const span = createMockSpan({ droppedEventsCount: 2 });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].droppedEventsCount,
      ).toBe(2);
    });

    it("propagates droppedLinksCount from span", () => {
      const span = createMockSpan({ droppedLinksCount: 1 });
      const result = serializeSpans([span]);
      expect(
        result.resourceSpans[0].scopeSpans[0].spans[0].droppedLinksCount,
      ).toBe(1);
    });
  });
});
