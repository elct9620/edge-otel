import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OtlpHttpJsonExporter } from "./exporter.js";
import type { TracerProviderOptions, TracerHandle } from "./types.js";
import "./context.js";

const INSTRUMENTATION_SCOPE_NAME = "ai";
const DEFAULT_SERVICE_NAME = "cloudflare-worker";

export function createTracerProvider(
  options: TracerProviderOptions,
): TracerHandle {
  const resource = resourceFromAttributes({
    "service.name": options.serviceName ?? DEFAULT_SERVICE_NAME,
  });

  const exporter = new OtlpHttpJsonExporter({
    endpoint: options.endpoint,
    headers: options.headers,
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const tracer = provider.getTracer(INSTRUMENTATION_SCOPE_NAME);

  return {
    tracer,
    flush: async () => {
      try {
        await exporter.forceFlush();
      } catch {
        // flush always resolves; never rejects
      }
    },
    rootSpan: (name, attributes) => {
      const span = tracer.startSpan(name, { attributes });
      const ctx = trace.setSpan(context.active(), span);
      return { span, ctx };
    },
  };
}
