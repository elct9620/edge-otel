import { context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OtlpHttpJsonExporter } from "./exporters/http.js";
import type { TracerProviderOptions, TracerProvider } from "./types.js";

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
): TracerProvider {
  ensureContextManager();
  const resource = resourceFromAttributes({
    "service.name": options.serviceName ?? DEFAULT_SERVICE_NAME,
    ...(options.resourceAttributes ?? {}),
  });

  const exporter = new OtlpHttpJsonExporter({
    endpoint: options.endpoint,
    headers: options.headers,
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  return {
    getTracer: (scopeName) => provider.getTracer(scopeName),
    forceFlush: async () => {
      try {
        await exporter.forceFlush();
      } catch (err) {
        console.warn("[edge-otel] forceFlush failed:", err);
      }
    },
  };
}
