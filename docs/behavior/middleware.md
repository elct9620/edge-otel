# Middleware

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

The middleware component manages the root span lifecycle for a complete request: it creates a root span, activates the request context, handles errors, ends the span, and registers the flush. It is the entry point for User Journey 2 (multiple AI SDK calls grouped under one trace).

The middleware is available in two variants: one for Hono applications and one for plain Cloudflare Workers fetch handlers. Both variants produce identical trace output; they differ only in how they access the execution context and request information.

---

## Middleware Lifecycle

_Corresponds to User Journey 2._

| Phase               | Behavior                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request start       | A root span is created with the configured name (e.g., `http.request`) and any provided attributes. The span becomes the active span for the duration of the request.                                                                                                                  |
| Context activation  | The downstream handler is invoked inside `context.with(ctx, handler)`, where `ctx` holds the root span as the active span. All AI SDK calls and manual spans created inside the handler inherit the root span's `traceId` and record the root span's `spanId` as their `parentSpanId`. |
| Normal completion   | The root span status is set to OK. The root span is ended. The flush is registered with `waitUntil` before the response is returned.                                                                                                                                                   |
| Exception thrown    | The exception is recorded on the root span via `recordException`. The root span status is set to ERROR. The root span is ended. The flush is registered with `waitUntil`. The exception is re-thrown to the runtime.                                                                   |
| Post-response flush | The flush promise is registered with `waitUntil` before the HTTP response is returned. The runtime keeps the isolate alive until the flush promise resolves or the `waitUntil` budget is exhausted.                                                                                    |

The root span is always ended unconditionally after the handler resolves or throws. The flush is always registered in the same unconditional cleanup phase, ensuring spans are exported even on error paths.

---

## Root Span Attributes

The middleware records the following on the root span at creation time.

| Attribute source  | Behavior                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Span name         | Configurable at middleware setup time. Defaults to `http.request` if not overridden.                                                                                              |
| Custom attributes | Any `Record<string, string>` attributes provided to the middleware configuration are set on the root span at creation.                                                            |
| Backend metadata  | Backend-specific attributes (e.g., `langfuse.user.id`, `langfuse.session.id`) can be set on the root span by the application before the span ends. See Backend-Specific Guidance. |

---

## Flush Timing

The ordering of operations is a correctness requirement, not a style preference.

| Rule                                                                   | Rationale                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitUntil(flush())` is registered BEFORE the response is returned     | `waitUntil` must be called while the execution context is still active. Calling it after the response object is constructed but before `return` is the only safe window.                           |
| The flush promise must resolve within the 30-second `waitUntil` budget | The runtime terminates all `waitUntil` promises after 30 seconds of wall-clock time post-response. A flush that takes longer than 30 seconds will be aborted and spans will be lost.               |
| `flush()` never rejects                                                | If the flush promise rejects, the `waitUntil` chain is interrupted and the runtime may terminate the isolate in an undefined state. All flush errors are caught internally and logged as warnings. |

---

## streamText Special Case

`streamText` responses require different flush sequencing than `generateText` responses.

| Condition                                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Response is a non-streaming `generateText` result | Flush is registered immediately after the handler returns, before the response is sent. All AI SDK spans have already ended when the handler returns.                                                                                                                                                                                                                                                                                    |
| Response is a `streamText` result                 | The AI SDK ends the streaming spans (`ai.streamText`, `ai.streamText.doStream`) only after the response stream is fully consumed by the client. The AI SDK result exposes a `consumedStream` promise that resolves when the stream is fully consumed. Flush must be chained after `consumedStream` resolves. If flush fires before `consumedStream` resolves, the streaming spans have not yet ended and will be absent from the export. |

When the handler returns a streaming response, the middleware chains the flush after `consumedStream` resolves rather than immediately in the unconditional cleanup phase. This ensures all streaming spans, including token usage and finish reason, are present in the buffer before the flush POST is made.

---

## Hono Variant

| Integration point    | Behavior                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Middleware signature | Conforms to Hono's standard middleware signature, receiving Hono's context and a `next` function.                                                           |
| Execution context    | The flush is registered via the execution context exposed by the framework's request context object.                                                        |
| Request information  | HTTP method, URL, and route path are available from Hono's context and can be set as root span attributes at middleware setup time.                         |
| Tracer availability  | The tracer is made available to route handlers via Hono's context variable store so each handler can pass it to AI SDK calls without constructor threading. |

---

## Plain Cloudflare Workers Fetch Handler Variant

| Integration point    | Behavior                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Handler signature    | Works with the standard `export default { fetch(request, env, ctx) }` pattern. No framework dependency.               |
| Execution context    | The flush is registered via `ctx.waitUntil(flush())` using the `ctx` parameter of the fetch handler directly.         |
| Request information  | HTTP method and URL are available from the `Request` object and can be set as root span attributes.                   |
| Environment bindings | The provider factory is called inside the fetch handler body where `env` bindings are available, not at module scope. |

---

## Error Scenarios

| Scenario                           | Middleware behavior                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler throws                     | The exception is recorded on the root span via `recordException`; the root span status is set to ERROR; the root span is ended; the flush is registered; the exception is re-thrown to the runtime unchanged. |
| `flush()` fails internally         | The error is caught inside the flush function and logged as a warning; the response is unaffected; the flush promise resolves rather than rejects so the `waitUntil` chain completes cleanly.                 |
| `waitUntil` budget exceeded (30 s) | The runtime terminates the isolate; any in-flight flush POST request is aborted by the runtime; the spans from that request are lost. This is an infrastructure constraint, not a middleware failure.         |
| Root span creation fails           | This indicates an internal OTel SDK error; the middleware does not suppress it. The downstream handler is not invoked.                                                                                        |
