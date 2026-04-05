import type { HrTime } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

// OTLP JSON wire format types (from docs/contracts.md)
// These are internal — not part of the public API.

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpEvent {
  name: string;
  timeUnixNano: string;
  attributes: OtlpKeyValue[];
  droppedAttributesCount: number;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: OtlpEvent[];
  status: { code: number; message?: string };
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
}

export interface OtlpScopeSpans {
  scope: { name: string; version?: string };
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: OtlpScopeSpans[];
}

export interface ExportTraceServiceRequest {
  resourceSpans: OtlpResourceSpans[];
}

/** Convert an HrTime [seconds, nanoseconds] tuple to a nanosecond decimal string.
 *  Uses string concatenation to avoid Number.MAX_SAFE_INTEGER overflow. */
function hrtimeToNanoString(hrTime: HrTime): string {
  return `${hrTime[0]}${hrTime[1].toString().padStart(9, "0")}`;
}

function toOtlpAnyValue(value: unknown): OtlpAnyValue {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toOtlpAnyValue) } };
  }
  // Fallback: encode as string
  return { stringValue: String(value) };
}

function toOtlpAttributes(attributes: Record<string, unknown>): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toOtlpAnyValue(value),
  }));
}

function toOtlpSpan(span: ReadableSpan): OtlpSpan {
  const ctx = span.spanContext();

  const otlpSpan: OtlpSpan = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    name: span.name,
    kind: span.kind + 1,
    startTimeUnixNano: hrtimeToNanoString(span.startTime),
    endTimeUnixNano: hrtimeToNanoString(span.endTime),
    attributes: toOtlpAttributes(span.attributes as Record<string, unknown>),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: hrtimeToNanoString(event.time),
      attributes: toOtlpAttributes(
        (event.attributes ?? {}) as Record<string, unknown>,
      ),
      droppedAttributesCount: event.droppedAttributesCount ?? 0,
    })),
    status: {
      code: span.status.code,
      ...(span.status.message !== undefined
        ? { message: span.status.message }
        : {}),
    },
    droppedAttributesCount: span.droppedAttributesCount ?? 0,
    droppedEventsCount: span.droppedEventsCount ?? 0,
    droppedLinksCount: span.droppedLinksCount ?? 0,
  };

  // Omit parentSpanId entirely for root spans
  const parentId = span.parentSpanContext?.spanId;
  if (parentId !== undefined && parentId !== "") {
    otlpSpan.parentSpanId = parentId;
  }

  return otlpSpan;
}

export function serializeSpans(
  spans: ReadableSpan[],
): ExportTraceServiceRequest {
  // Group spans by resource identity then by instrumentation scope.
  // We use JSON-stringified resource attributes as a grouping key.
  const resourceMap = new Map<string, Map<string, ReadableSpan[]>>();

  for (const span of spans) {
    const resourceKey = JSON.stringify(span.resource.attributes);
    const scopeKey = `${span.instrumentationScope.name}@${span.instrumentationScope.version ?? ""}`;

    let scopeMap = resourceMap.get(resourceKey);
    if (scopeMap === undefined) {
      scopeMap = new Map<string, ReadableSpan[]>();
      resourceMap.set(resourceKey, scopeMap);
    }

    let bucket = scopeMap.get(scopeKey);
    if (bucket === undefined) {
      bucket = [];
      scopeMap.set(scopeKey, bucket);
    }

    bucket.push(span);
  }

  const resourceSpans: OtlpResourceSpans[] = [];

  for (const [, scopeMap] of resourceMap) {
    // Reconstruct resource attributes from the first span in the group
    const firstSpan = [...scopeMap.values()][0][0];
    const resourceAttributes = toOtlpAttributes(
      firstSpan.resource.attributes as Record<string, unknown>,
    );

    const scopeSpans: OtlpScopeSpans[] = [];

    for (const [, bucket] of scopeMap) {
      const lib = bucket[0].instrumentationScope;
      const scope: OtlpScopeSpans["scope"] = { name: lib.name };
      if (lib.version !== undefined && lib.version !== "") {
        scope.version = lib.version;
      }
      scopeSpans.push({
        scope,
        spans: bucket.map(toOtlpSpan),
      });
    }

    resourceSpans.push({
      resource: { attributes: resourceAttributes },
      scopeSpans,
    });
  }

  return { resourceSpans };
}
