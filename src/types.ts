import type { Tracer, Span, Context } from "@opentelemetry/api";

export interface ExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

export interface TracerProviderOptions extends ExporterConfig {
  serviceName?: string;
}

export interface TracerHandle {
  tracer: Tracer;
  flush: () => Promise<void>;
  rootSpan: (
    name: string,
    attributes?: Record<string, string>,
  ) => { span: Span; ctx: Context };
}
