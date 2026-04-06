import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export function createMockSpan(
  overrides?: Record<string, unknown>,
): ReadableSpan {
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
