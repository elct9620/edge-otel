import { context, SpanStatusCode } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import type { TracerHandle } from "../types.js";

export interface HonoMiddlewareOptions {
  spanName?: string;
  attributes?: Record<string, string>;
}

export function createHonoMiddleware(
  handle: TracerHandle,
  options?: HonoMiddlewareOptions,
): MiddlewareHandler {
  const spanName = options?.spanName ?? "http.request";
  const attributes = options?.attributes;

  return async (c, next) => {
    const { span, ctx } = handle.rootSpan(spanName, attributes);

    await context.with(ctx, async () => {
      c.set("tracer", handle.tracer);

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
        c.executionCtx.waitUntil(handle.flush());
      }
    });
  };
}
