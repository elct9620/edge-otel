# Tracer Provider Factory

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

The factory accepts configuration, wires internal components together, and returns a handle that the application uses to instrument AI SDK calls, create custom spans, and flush completed spans after the HTTP response is sent. The factory does not validate credentials at construction time — credential errors surface as HTTP 401 responses during `flush()`.

---

## Factory Output — Handle

The factory returns a handle with three members. All three are required for a complete integration.

| Member     | Type                                                                                  | Contract                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracer`   | `Tracer`                                                                              | Passed directly to `experimental_telemetry.tracer` on every AI SDK call. Never registered globally.                                                                                                                                             |
| `flush`    | `() => Promise<void>`                                                                 | Drains the in-memory span buffer and exports all buffered spans to the configured endpoint. Must be registered with `ctx.waitUntil(flush())` before the HTTP response is sent. Always resolves; never rejects.                                  |
| `rootSpan` | `(name: string, attributes?: Record<string, string>) => { span: Span; ctx: Context }` | Creates a named span with optional attributes and returns both the span and a context object with that span set as active. The caller passes the returned `ctx` to `context.with(ctx, handler)` to activate it for the duration of the request. |

---

## Global Registration Avoidance

The factory does **not** call `provider.register()`.

The tracer is passed directly to each AI SDK call via `experimental_telemetry.tracer`. Registering the provider as the global OTel singleton is unnecessary and carries two risks in V8 isolate runtimes:

| Risk                                             | Consequence                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Polluting the global OTel singleton              | Other OTel users in the same module scope observe unexpected state                               |
| State leakage across requests sharing an isolate | A provider created for one request's credentials could intercept spans from a subsequent request |

---

## Instrumentation Scope Name

The tracer is obtained with the instrumentation scope name specified by the `scopeName` configuration option. The default is `'ai'`.

`'ai'` is the AI SDK convention for AI/LLM operation tracing. The AI SDK emits spans under this scope name, and backends that support AI SDK integration key on this value to classify and enrich AI operation data. The default can be overridden at provider creation time for non-AI-SDK use cases.

---

## Span Processor Wiring

| Processor             | Behavior                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SimpleSpanProcessor` | Calls `exporter.export()` synchronously on each `span.end()`. No batch window, no background timer. One processor per exporter. |

`BatchSpanProcessor` is not used. It depends on a recurring background timer that does not survive isolate shutdown, causing spans to be silently dropped.

---

## Resource Attributes

Every span exported by the provider carries the following resource attributes.

| Attribute                | Source                               | Notes                                                                                                            |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `service.name`           | Configuration (`serviceName`)        | Defaults to `'cloudflare-worker'`. Standard OTel resource attribute.                                             |
| Custom attributes        | Configuration (`resourceAttributes`) | Additional key-value pairs merged into the resource. Examples: `deployment.environment.name`, `service.version`. |
| `telemetry.sdk.name`     | OTel SDK                             | Populated automatically by the SDK.                                                                              |
| `telemetry.sdk.language` | OTel SDK                             | Populated automatically by the SDK.                                                                              |
| `telemetry.sdk.version`  | OTel SDK                             | Populated automatically by the SDK.                                                                              |

---

## Context Manager Registration

The `@opentelemetry/context-async-hooks` package is an unconditional dependency. It is imported and the `AsyncLocalStorageContextManager` is registered at **module scope** — before any request handler fires. This means the `nodejs_compat` compatibility flag (or equivalent runtime support for `AsyncLocalStorage`) is a prerequisite for deploying with this package. Without `nodejs_compat`, the module-level import fails and the Worker does not start.

| Timing                             | Behavior                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Module load (cold start)           | `AsyncLocalStorageContextManager` is enabled and set as the global context manager. Runs exactly once per isolate lifetime.  |
| Subsequent requests (warm isolate) | Registration is already in place; no re-registration occurs.                                                                 |
| `nodejs_compat` absent             | Module import fails at load time; the Worker does not start. This is a deployment-time error, not a silent runtime fallback. |

Registration must occur at module scope, not inside a request handler or the factory body. Placing it inside per-request code means it runs after the first span may already have been created, and context propagation would be unreliable for that request.

For deployments that cannot enable `nodejs_compat`, context propagation is unavailable through this package. Single AI SDK calls per request still produce correct traces (each call gets its own trace), but multi-call grouping under one trace requires manual `context.with()` threading, which is outside the scope of this factory.

---

## Root-Span Helper

The `rootSpan(name, attributes?)` helper creates a named span and activates it as the current context.

| Step                  | Observable behavior                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call `rootSpan(name)` | A new span is started with the given name and any provided attributes.                                                                                                                          |
| Returned `span`       | The caller is responsible for calling `span.end()` after the request completes, in a `finally` block.                                                                                           |
| Returned `ctx`        | An OTel `Context` object with the new span set as the active span.                                                                                                                              |
| Caller wraps handler  | `context.with(ctx, handler)` activates the context for the duration of `handler`. All AI SDK calls and `tracer.startActiveSpan()` calls inside `handler` inherit the root span as their parent. |

The root-span helper is designed for Hono middleware and plain Worker fetch handlers that need to parent all AI SDK spans under a single per-request root span.

---

## Configuration

The factory accepts the following configuration:

| Category                   | Required | Default               | Description                                                                                                                           |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint URL               | Yes      | —                     | The OTLP/HTTP endpoint to which spans are exported. No default; backend presets provide this value.                                   |
| Authentication credentials | Yes      | —                     | Credentials used to authenticate with the OTLP endpoint (e.g., as HTTP Basic Auth). No default; backend presets provide these values. |
| `serviceName`              | No       | `'cloudflare-worker'` | Value of the `service.name` resource attribute. Standard OTel resource attribute identifying the reporting service.                   |
| `scopeName`                | No       | `'ai'`                | Instrumentation scope name for the tracer. Default matches AI SDK convention.                                                         |
| `resourceAttributes`       | No       | `{}`                  | Additional OTel resource attributes merged into the resource (e.g., `deployment.environment.name`, `service.version`).                |

The shape of the credentials and the exact field names are determined by the implementation. Backend-specific presets (such as a Langfuse preset) supply the endpoint URL and credential values from backend-specific configuration.

---

## Error Scenarios

| Scenario                                                 | Factory behavior                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication credentials are absent or empty           | The factory produces a handle, but every `forceFlush()` call results in an HTTP 401 response; spans are dropped and a warning is logged. |
| Endpoint URL is malformed                                | `flush()` rejects the `fetch()` call; the error is caught, a warning is logged, and spans are dropped. `flush()` still resolves.         |
| `rootSpan()` called before context manager is registered | The span is created without an active parent; it becomes a root span as expected. No error is thrown.                                    |
| `flush()` called with an empty buffer                    | Resolves immediately; no HTTP request is made.                                                                                           |
