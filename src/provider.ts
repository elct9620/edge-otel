import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OtlpHttpJsonExporter } from "./exporters/http.js";
import type { TracerProviderOptions, TracerHandle } from "./types.js";

const DEFAULT_SERVICE_NAME = "cloudflare-worker";

let contextManagerRegistered = false;

function ensureContextManager(): void {
  if (contextManagerRegistered) return;
  contextManagerRegistered = true;
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
}

export function createTracerProvider(
  options: TracerProviderOptions,
): TracerHandle {
  ensureContextManager();
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

  const tracer = provider.getTracer(options.scopeName ?? "ai");

  return {
    tracer,
    flush: () => exporter.forceFlush(),
    rootSpan: (name, attributes) => {
      const span = tracer.startSpan(name, { attributes });
      const ctx = trace.setSpan(context.active(), span);
      return { span, ctx };
    },
  };
}
