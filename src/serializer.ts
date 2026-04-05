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

export function serializeSpans(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spans: ReadableSpan[],
): ExportTraceServiceRequest {
  // TODO: implement OTLP JSON serialization
  return { resourceSpans: [] };
}
