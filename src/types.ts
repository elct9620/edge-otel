import type { Tracer } from "@opentelemetry/api";

export interface ExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

export interface TracerProviderOptions extends ExporterConfig {
  serviceName?: string;
  scopeName?: string;
  resourceAttributes?: Record<string, string>;
}

export interface TracerProvider {
  getTracer(scopeName: string): Tracer;
  forceFlush(): Promise<void>;
}
