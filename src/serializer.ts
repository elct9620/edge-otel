import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface ExportTraceServiceRequest {
  resourceSpans: unknown[];
}

export function serializeSpans(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spans: ReadableSpan[],
): ExportTraceServiceRequest {
  // TODO: implement OTLP JSON serialization
  return { resourceSpans: [] };
}
