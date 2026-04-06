import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import type { TracerProvider } from "../types.js";

export interface HonoMiddlewareOptions {
  spanName?: string;
  scopeName?: string;
  attributes?: Record<string, string>;
}

const DEFAULT_SCOPE_NAME = "ai";

export function createHonoMiddleware(
  provider: TracerProvider,
  options?: HonoMiddlewareOptions,
): MiddlewareHandler {
  const spanName = options?.spanName ?? "http.request";
  const attributes = options?.attributes;
  const tracer = provider.getTracer(options?.scopeName ?? DEFAULT_SCOPE_NAME);

  return async (c, next) => {
    const span = tracer.startSpan(spanName, { attributes });
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, async () => {
      let deferredPromise: Promise<unknown> | undefined;
      const deferFlush = (promise: Promise<unknown>): void => {
        deferredPromise = promise;
      };

      c.set("tracer", tracer);
      c.set("deferFlush", deferFlush);

      try {
        await next();

        if (c.error) {
          span.recordException(c.error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: c.error.message,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        span.end();
        if (deferredPromise !== undefined) {
          c.executionCtx.waitUntil(
            deferredPromise.then(() => provider.forceFlush()),
          );
        } else {
          c.executionCtx.waitUntil(provider.forceFlush());
        }
      }
    });
  };
}
