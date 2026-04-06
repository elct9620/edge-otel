# Tracer Provider Factory

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

The factory accepts configuration, wires internal components together, and returns a provider that the application uses to obtain tracers, instrument AI SDK calls, and flush completed spans after the HTTP response is sent. The factory does not validate credentials at construction time — credential errors surface as HTTP 401 responses during `forceFlush()`.

---

## Alignment with Standard OTel Convention

This package follows standard OpenTelemetry convention:

1. Call `createTracerProvider(options)` to obtain a provider.
2. Call `provider.getTracer(scopeName)` to obtain a `Tracer` for a specific instrumentation scope.
3. Pass the tracer to AI SDK calls via `experimental_telemetry.tracer`.
4. Call `provider.forceFlush()` (registered with `ctx.waitUntil`) to drain and export spans after each request.

The provider is **not** registered as the global OTel singleton. The tracer is passed directly to each AI SDK call. This avoids the risks associated with global registration in V8 isolate runtimes (see Global Registration Avoidance below).

---

## Factory Output — Provider

The factory returns a provider with two members. Both are required for a complete integration.

| Member       | Type                            | Contract                                                                                                                                                                                                                                            |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getTracer`  | `(scopeName: string) => Tracer` | Returns a `Tracer` bound to the given instrumentation scope name. Pass this tracer to `experimental_telemetry.tracer` on every AI SDK call. The `'ai'` scope name is the AI SDK convention for AI/LLM operation tracing. Never registered globally. |
| `forceFlush` | `() => Promise<void>`           | Drains the in-memory span buffer and exports all buffered spans to the configured endpoint. Must be registered with `ctx.waitUntil(provider.forceFlush())` before the HTTP response is sent. Always resolves; never rejects.                        |

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

The instrumentation scope name is passed to `provider.getTracer(scopeName)` at the point of tracer acquisition, not at provider creation time. This follows standard OTel convention — scope is a property of the tracer, not the provider.

`'ai'` is the AI SDK convention for AI/LLM operation tracing. The AI SDK emits spans under this scope name, and backends that support AI SDK integration key on this value to classify and enrich AI operation data. Pass `'ai'` when obtaining a tracer for AI SDK calls.

```typescript
const tracer = provider.getTracer("ai");
```

---

## AI SDK–Generated Spans

The AI SDK emits spans autonomously when `experimental_telemetry.tracer` is set. These spans are created by the AI SDK, not by user code, and include both the primary call spans and any tool call spans generated during multi-step tool use.

| Span name pattern                         | Created by | Notes                                                                                                     |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `ai.generateText`                         | AI SDK     | Top-level span for a `generateText` call; parentage determined by active context at call time.            |
| `ai.generateText.doGenerate`              | AI SDK     | Child of `ai.generateText`; one per LLM invocation including retries and multi-step continuations.        |
| `ai.streamText`, `ai.streamText.doStream` | AI SDK     | Equivalent spans for streaming calls.                                                                     |
| `ai.toolCall`                             | AI SDK     | Child of the top-level `ai.generateText` or `ai.streamText` span; sibling of `doGenerate`, not its child. |

`ai.toolCall` spans are recorded under the same instrumentation scope as the tracer passed to the AI SDK call. Pass a tracer obtained with `provider.getTracer('ai')` to ensure all AI SDK spans, including tool call spans, are emitted under the `'ai'` scope. Backends that classify observations by scope name (such as Langfuse) apply scope-specific logic to all spans under that scope.

The `ai.toolCall` span name does not match Langfuse's generation detection rules, so it is always classified as a generic Span observation regardless of scope name.

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

The `@opentelemetry/context-async-hooks` package is an unconditional dependency. The `AsyncLocalStorageContextManager` is registered on the first call to `createTracerProvider()`, with a guard that ensures registration happens exactly once. The `nodejs_compat` compatibility flag (or equivalent runtime support for `AsyncLocalStorage`) is a prerequisite for deploying with this package.

| Timing                                    | Behavior                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| First `createTracerProvider()` call       | `AsyncLocalStorageContextManager` is enabled and set as the global context manager. Runs exactly once per isolate lifetime.  |
| Subsequent `createTracerProvider()` calls | Registration is already in place; no re-registration occurs.                                                                 |
| `nodejs_compat` absent                    | Module import fails at load time; the Worker does not start. This is a deployment-time error, not a silent runtime fallback. |

For deployments that cannot enable `nodejs_compat`, context propagation is unavailable through this package. Single AI SDK calls per request still produce correct traces (each call gets its own trace), but multi-call grouping under one trace requires manual `context.with()` threading, which is outside the scope of this factory.

---

## Root Span Creation

Root spans are created using the standard OTel `Tracer` API — there is no custom helper method on the provider. The application calls `tracer.startActiveSpan(name, fn)` to create a span and activate it as the current context for the duration of `fn`.

```typescript
const provider = createTracerProvider({ ...langfuseExporter({ ... }), serviceName: "my-app" });
const tracer = provider.getTracer("ai");

tracer.startActiveSpan("request", async (span) => {
  try {
    // All AI SDK calls and tracer.startActiveSpan() calls inside here
    // inherit the root span as their parent automatically.
    await generateText({ model, experimental_telemetry: { tracer } });
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
});
```

All AI SDK spans and manual spans created inside `startActiveSpan`'s callback inherit the root span's `traceId` and record the root span's `spanId` as their `parentSpanId`.

---

## Configuration

The factory accepts the following configuration:

| Category                   | Required | Default               | Description                                                                                                                           |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint URL               | Yes      | —                     | The OTLP/HTTP endpoint to which spans are exported. No default; backend presets provide this value.                                   |
| Authentication credentials | Yes      | —                     | Credentials used to authenticate with the OTLP endpoint (e.g., as HTTP Basic Auth). No default; backend presets provide these values. |
| `serviceName`              | No       | `'cloudflare-worker'` | Value of the `service.name` resource attribute. Standard OTel resource attribute identifying the reporting service.                   |
| `resourceAttributes`       | No       | `{}`                  | Additional OTel resource attributes merged into the resource (e.g., `deployment.environment.name`, `service.version`).                |

The shape of the credentials and the exact field names are determined by the implementation. Backend-specific presets (such as a Langfuse preset) supply the endpoint URL and credential values from backend-specific configuration.

---

## Error Scenarios

| Scenario                                                  | Factory behavior                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication credentials are absent or empty            | The factory produces a provider, but every `forceFlush()` call results in an HTTP 401 response; spans are dropped and a warning is logged. |
| Endpoint URL is malformed                                 | `forceFlush()` rejects the `fetch()` call; the error is caught, a warning is logged, and spans are dropped. `forceFlush()` still resolves. |
| `getTracer()` called before context manager is registered | The span is created without an active parent; it becomes a root span as expected. No error is thrown.                                      |
| `forceFlush()` called with an empty buffer                | Resolves immediately; no HTTP request is made.                                                                                             |
