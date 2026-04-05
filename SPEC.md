# edge-otel-ts Specification

## Intent

### Purpose

Developers building AI-powered applications on Cloudflare Workers with the Vercel AI SDK cannot observe their LLM calls in Langfuse. Every available integration path fails in V8 isolate runtimes.

**Problem: Node.js OTel SDK is incompatible with V8 isolate runtimes**

| Missing capability                                            | Effect on OTel SDK                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `node:perf_hooks` absent or mocked (returns `timeOrigin = 0`) | Span timestamps silently corrupt — wrong values, no error thrown                               |
| `node:async_hooks` absent without `nodejs_compat` flag        | Context propagation fails; each AI SDK call starts a new unrelated trace                       |
| `node:http` / `node:https` absent                             | HTTP and gRPC exporters cannot open connections                                                |
| No TCP sockets                                                | gRPC transport is unavailable; all outbound I/O must use `fetch()`                             |
| No background timers that survive request end                 | `BatchSpanProcessor` drops all buffered spans when the isolate exits                           |
| No shared state across requests                               | Module-level OTel singletons cannot be assumed to persist; global registry risks state leakage |

**Problem: All existing solutions fail**

| Solution                                     | Failure mode                                                                                                                                             | Status                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@langfuse/otel` + `@opentelemetry/sdk-node` | Build error (`Could not resolve "perf_hooks"`) or runtime error (`Cannot convert object to primitive value`) from `sdk-trace-node` transitive dependency | Broken in V8 isolates                                          |
| `langfuse-vercel`                            | Same transitive dependency on `sdk-trace-node` via `@ai-sdk/otel`                                                                                        | Deprecated August 2025; broken in V8 isolates                  |
| `@microlabs/otel-cf-workers`                 | Instruments HTTP and CF bindings, not the AI SDK span tree; no `LangfuseSpanProcessor` equivalent; RC status; larger surface area than required          | Viable for general observability; wrong fit for AI SDK tracing |
| Cloudflare automatic tracing                 | Captures infrastructure spans only; does not capture `ai.generateText`, `ai.streamText`, or `ai.toolCall` spans emitted by the AI SDK                    | Complementary, not a substitute                                |

**This package provides a correct integration path** by building on only the runtime-agnostic layers of the OTel SDK (`sdk-trace-base`, not `sdk-trace-node`) and using only Web Platform APIs (`fetch()`, `btoa()`, `crypto`, `JSON`) for export.

---

### Users

**Primary: Application developers** deploying Vercel AI SDK workloads to serverless runtimes

| User                            | Context                                                                                        | Need                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers developer    | Building AI features with Hono or plain Worker handlers; Langfuse as the observability backend | OTel traces from `generateText` / `streamText` calls appear in Langfuse without Node.js SDK dependencies |
| Deno Deploy developer           | Same AI SDK stack; Deno's `node:async_hooks` compat available                                  | Same trace export without platform-specific changes                                                      |
| Vercel Edge Functions developer | V8 isolate model identical to Cloudflare Workers; same runtime constraints apply               | Same trace export without platform-specific changes                                                      |

**Non-users (out of scope)**

| Excluded user                                                  | Reason                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Node.js server developers                                      | `@langfuse/otel` + `@opentelemetry/sdk-node` already works correctly on Node.js |
| Developers needing gRPC / protobuf export                      | Not supported; OTLP/HTTP + JSON is sufficient for all major OTel collectors     |
| Developers instrumenting CF bindings (KV, D1, Durable Objects) | Out of scope; `@microlabs/otel-cf-workers` covers that use case                 |

---

### Impacts

**Before this package exists**

| Scenario                                                                                         | Outcome                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer follows Langfuse official docs (NodeSDK + LangfuseSpanProcessor) on Cloudflare Workers | Build fails or spans are silently dropped; no traces appear in Langfuse                                                                                                                                        |
| Developer enables `nodejs_compat` and retries                                                    | `perf_hooks` polyfill returns `timeOrigin = 0`; all span timestamps are wrong; failure is silent                                                                                                               |
| Developer uses `@microlabs/otel-cf-workers` pointed at Langfuse OTLP endpoint                    | HTTP and CF binding spans export correctly; AI SDK spans (`ai.generateText`, etc.) do not appear because the AI SDK requires a registered `TracerProvider` with a `tracer` passed via `experimental_telemetry` |

**After this package exists**

| Capability                                                                      | State                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AI SDK spans export to Langfuse from Cloudflare Workers                         | Supported                                                                                |
| Multiple AI SDK calls within one request grouped under one Langfuse trace       | Supported — requires `nodejs_compat` flag for multi-call grouping                        |
| Custom application spans (RAG retrieval, DB queries) included in the same trace | Supported                                                                                |
| Span export completes after the HTTP response is sent                           | Supported — isolate lifetime is extended until export resolves                           |
| Thrown exceptions from AI SDK calls appear as `ERROR` in Langfuse               | Supported — no manual error annotation required                                          |
| Target backend is swappable to any OTLP/HTTP + JSON collector                   | Supported — URL and credentials are runtime configuration, not compile-time dependencies |
| Timestamps are correct in V8 isolates                                           | Supported — does not depend on `node:perf_hooks`                                         |

## Scope

### Feature List

| #   | Feature                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OTLP/HTTP JSON span exporter using only Web Platform APIs (`fetch`, `btoa`, `crypto`) — no Node.js built-ins required            |
| 2   | Langfuse as the default backend, with any OTLP/HTTP + JSON-compatible backend selectable via constructor configuration           |
| 3   | `SimpleSpanProcessor` for per-span buffering with explicit flush via `forceFlush()` — no background timer dependency             |
| 4   | `AsyncLocalStorage`-based context propagation that groups all AI SDK calls within a single request under one trace               |
| 5   | Automatic error tracking: thrown exceptions are recorded as span events and marked `ERROR` status without manual instrumentation |
| 6   | Manual span creation via the standard OTel `Tracer` API for custom instrumentation (RAG retrieval, database queries, etc.)       |
| 7   | Hono middleware for root span lifecycle management: span creation, context activation, error capture, and flush registration     |

---

### IS / IS NOT

| IS                                                                                                         | IS NOT                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A standard OTel `SpanExporter` implementation on top of `sdk-trace-base`                                   | A full OTel SDK reimplementation from scratch                                                                 |
| Cloudflare Workers as the primary target runtime, portable to Deno Deploy and Vercel Edge by design        | Node.js server support (`@langfuse/otel` + `@opentelemetry/sdk-node` already handles that)                    |
| Langfuse as the default backend, any OTLP/HTTP + JSON collector as an alternative                          | gRPC or protobuf transport support                                                                            |
| `AsyncLocalStorage`-based context propagation for multi-call trace merging (requires `nodejs_compat` flag) | Automatic propagation without the `nodejs_compat` flag                                                        |
| Automatic `ERROR` status when exceptions are thrown by AI SDK calls                                        | Automatic `WARNING` status for soft failures (`finishReason = "error"`) — that remains manual                 |
| Manual spans via the standard OTel `Tracer` API                                                            | Auto-instrumentation of Cloudflare bindings (KV, D1, Durable Objects)                                         |
| Minimal dependency surface: 4 OTel packages only                                                           | Dependency on `@opentelemetry/sdk-node`, `@langfuse/otel`, `langfuse-vercel`, or `@microlabs/otel-cf-workers` |

---

### Dependencies

| Package                              | Role                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opentelemetry/api`                 | Core OTel interfaces: `Tracer`, `Span`, `SpanKind`, `SpanStatusCode`, `context`, `trace`                                                                  |
| `@opentelemetry/sdk-trace-base`      | Runtime-agnostic tracing primitives: `BasicTracerProvider`, `SimpleSpanProcessor`, `ReadableSpan`, `SpanExporter`                                         |
| `@opentelemetry/resources`           | `Resource` descriptor carrying `service.name` and `telemetry.sdk.*` attributes                                                                            |
| `@opentelemetry/context-async-hooks` | `AsyncLocalStorageContextManager` for context propagation across `await` boundaries — requires `nodejs_compat` flag; the Worker will not start without it |

### User Journeys

**Journey 1: Single AI SDK call per request**

|             |                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer has one `generateText` or `streamText` call per Worker request handler and wants it to appear as a trace in Langfuse.                                                                                               |
| **Action**  | The developer configures the provider with Langfuse credentials, passes the resulting tracer to `experimental_telemetry.tracer` on the AI SDK call, and registers the flush with `ctx.waitUntil` before returning the response. |
| **Outcome** | A single Langfuse trace appears containing the AI SDK span tree (`ai.generateText`, `ai.generateText.doGenerate`) with correct timestamps, token usage, and model attributes.                                                   |

---

**Journey 2: Multiple AI SDK calls grouped under one trace**

|             |                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer makes multiple sequential `generateText` or `streamText` calls within one request (for example, summarise → translate → format) and wants all calls to appear as one Langfuse trace rather than separate unrelated traces.                                                                         |
| **Action**  | The developer enables the `nodejs_compat` compatibility flag, uses the Hono middleware (or a plain Cloudflare Workers fetch handler with the same root-span pattern) to create a root span and activate it as the request context, then passes the tracer to each AI SDK call within the same request handler. |
| **Outcome** | All AI SDK spans from the request share a single `traceId` and appear as sibling children under the root span in one Langfuse trace; token usage is rolled up across all calls.                                                                                                                                |

---

**Journey 3: Custom instrumentation alongside AI SDK calls**

|             |                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer wants RAG retrieval steps, database queries, or other application-level operations to appear as spans in the same Langfuse trace as the AI SDK calls.                         |
| **Action**  | The developer uses the tracer returned by the provider factory to create manual spans for the custom operations, keeping them within the same active request context as the AI SDK calls. |
| **Outcome** | Custom spans appear as siblings alongside the AI SDK spans under the same root trace in Langfuse, giving a complete end-to-end view of the request.                                       |

---

**Journey 4: Automatic error observation**

|             |                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call throws an exception — such as an API authentication error, rate limit response, or network timeout — during request processing.                               |
| **Action**  | No manual action is required; the AI SDK records the exception on the span and sets the span status to ERROR before re-throwing.                                             |
| **Outcome** | The span appears in Langfuse as `level = "ERROR"` with the exception type, message, and stack trace recorded as a span event; the trace-level severity is also marked ERROR. |

---

**Journey 5: Soft error warning (manual)**

|             |                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call returns successfully (no exception thrown) but `finishReason` is `"error"` or `"content-filter"`, indicating the generation was not completed as expected.                                               |
| **Action**  | After the AI SDK call returns, the developer inspects `finishReason` and sets the Langfuse-specific `langfuse.observation.level` attribute to `"WARNING"` on the active span, along with an explanatory status message. |
| **Outcome** | The observation appears in Langfuse as `level = "WARNING"` with the status message, making the soft failure visible without marking the span as a hard error in other OTel backends.                                    |

---

**Journey 6: Swapping the export backend**

|             |                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer wants to send traces to a different OTLP-compatible collector — such as Grafana Tempo, Jaeger, Honeycomb, or a self-hosted OpenTelemetry Collector — instead of Langfuse. |
| **Action**  | The developer changes the URL and authorization credentials in the provider constructor configuration; no other code changes are required.                                            |
| **Outcome** | The same AI SDK spans are exported to the alternative collector using OTLP/HTTP JSON; the AI SDK integration layer, middleware, and context propagation are unaffected.               |

---

**Journey 7: Multi-call trace grouping without `nodejs_compat`**

|             |                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer cannot enable the `nodejs_compat` flag (due to policy or binary size constraints) but still wants multiple AI SDK calls within one request to share a single trace in Langfuse.         |
| **Action**  | The developer creates a root span manually and wraps each AI SDK call individually in an explicit `context.with()` call that sets the root span as the active context immediately before each call. |
| **Outcome** | All AI SDK calls inherit the root span's `traceId` via manual context threading and appear as children under the same Langfuse trace, without requiring `AsyncLocalStorage`.                        |

---

## Behavior

### OTLP Span Exporter

The exporter accumulates spans in memory during a request and exports them to an OTLP/HTTP JSON endpoint in a single flush after the HTTP response is sent. All network I/O is deferred to the flush operation; no network calls occur during span recording.

---

#### Exporter Operations

| Operation       | Trigger                                                           | Contract                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export(spans)` | Called by the span processor after each span ends                 | Appends spans to an in-memory buffer. Returns `SUCCESS` immediately. No network I/O.                                                                                                               |
| `forceFlush()`  | Called explicitly before the isolate exits (e.g. `ctx.waitUntil`) | Drains the buffer atomically, serializes all buffered spans, and POSTs them to the configured endpoint. Resolves without rejecting regardless of outcome. Errors are logged and spans are dropped. |
| `shutdown()`    | Called when the provider is torn down                             | Calls `forceFlush()` to drain any remaining spans, then marks the exporter as closed. Subsequent `export()` calls on a closed exporter are no-ops.                                                 |

**Atomicity of flush**: the buffer is fully drained before the POST begins. If `forceFlush()` is called while the buffer is empty, the operation is a no-op and resolves immediately.

**No retry**: `forceFlush()` makes exactly one POST attempt per flush cycle. Failed spans are dropped.

---

#### Wire Format — OTLP/HTTP JSON Encoding Rules

The request body is an `ExportTraceServiceRequest` object. Spans are grouped by resource and instrumentation scope.

| Field                   | Encoding rule                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traceId`               | Lowercase hex string, 32 characters (128-bit identifier)                                                                                                                              |
| `spanId`                | Lowercase hex string, 16 characters (64-bit identifier)                                                                                                                               |
| `parentSpanId`          | Lowercase hex string, 16 characters — **omitted entirely for root spans** (an empty string is incorrect and causes backend rejection)                                                 |
| `startTimeUnixNano`     | Nanosecond-precision Unix epoch encoded as a **decimal string** (not a number — the value exceeds `Number.MAX_SAFE_INTEGER`)                                                          |
| `endTimeUnixNano`       | Nanosecond-precision Unix epoch encoded as a **decimal string** (not a number — the value exceeds `Number.MAX_SAFE_INTEGER`)                                                          |
| `kind`                  | Integer: `1` = INTERNAL, `2` = SERVER, `3` = CLIENT, `4` = PRODUCER, `5` = CONSUMER                                                                                                   |
| Attribute `stringValue` | UTF-8 string                                                                                                                                                                          |
| Attribute `intValue`    | Decimal string (not a number — token counts and other counters may exceed `Number.MAX_SAFE_INTEGER`)                                                                                  |
| Attribute `doubleValue` | JSON number                                                                                                                                                                           |
| Attribute `boolValue`   | JSON boolean                                                                                                                                                                          |
| Attribute `arrayValue`  | Object with a `values` array, each element a typed wrapper                                                                                                                            |
| Attribute `kvlistValue` | Object with a `values` array of `{ key, value }` pairs, each value a typed wrapper                                                                                                    |
| `status.code`           | Integer: `0` = UNSET, `1` = OK, `2` = ERROR                                                                                                                                           |
| Grouping                | Spans sharing the same resource are placed under one `resourceSpans` entry; spans sharing the same instrumentation scope are placed under one `scopeSpans` entry within that resource |

---

#### Authentication

| Header                         | Value                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`                | `Basic <base64(publicKey:secretKey)>` — the public key is the Basic Auth username; the secret key is the password               |
| `Content-Type`                 | `application/json`                                                                                                              |
| `x-langfuse-ingestion-version` | `4` — activates the fast-path ingestion pipeline; without this header, spans may be delayed up to 10 minutes in the Langfuse UI |

---

#### Constraints

| Constraint           | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| Maximum payload size | 4.5 MB — payloads exceeding this limit are rejected by the endpoint with HTTP 413 |
| Transport            | OTLP/HTTP JSON only — gRPC and protobuf are not used                              |
| Platform APIs        | `fetch()` and `btoa()` only — no Node.js built-ins                                |
| Endpoint path        | `{baseUrl}/api/public/otel/v1/traces`                                             |

---

#### Error Scenarios

| Scenario                                      | Exporter behavior                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Network failure during POST                   | Log warning; drop all spans from the flush cycle                         |
| HTTP 400 (malformed payload)                  | Log warning; drop all spans — the payload will not become valid on retry |
| HTTP 401 (authentication failure)             | Log warning; drop all spans                                              |
| HTTP 413 (payload too large)                  | Log warning; drop all spans                                              |
| Any other non-2xx response                    | Log warning with the HTTP status code; drop all spans                    |
| `export()` called after `shutdown()`          | No-op — spans are silently discarded, no error is thrown                 |
| Buffer is empty when `forceFlush()` is called | Resolve immediately; no POST is made                                     |

In all failure cases `forceFlush()` resolves (does not reject), preserving the `ctx.waitUntil()` promise chain.

---

### Tracer Provider Factory

The factory accepts configuration, wires internal components together, and returns a handle that the application uses to instrument AI SDK calls, create custom spans, and flush completed spans after the HTTP response is sent. The factory does not validate credentials at construction time — credential errors surface as HTTP 401 responses during `flush()`.

---

#### Factory Output — Handle

The factory returns a handle with three members. All three are required for a complete integration.

| Member     | Type                                                                                  | Contract                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracer`   | `Tracer`                                                                              | Passed directly to `experimental_telemetry.tracer` on every AI SDK call. Never registered globally.                                                                                                                                             |
| `flush`    | `() => Promise<void>`                                                                 | Drains the in-memory span buffer and exports all buffered spans to the configured endpoint. Must be registered with `ctx.waitUntil(flush())` before the HTTP response is sent. Always resolves; never rejects.                                  |
| `rootSpan` | `(name: string, attributes?: Record<string, string>) => { span: Span; ctx: Context }` | Creates a named span with optional attributes and returns both the span and a context object with that span set as active. The caller passes the returned `ctx` to `context.with(ctx, handler)` to activate it for the duration of the request. |

---

#### Global Registration Avoidance

The factory does **not** call `provider.register()`.

The tracer is passed directly to each AI SDK call via `experimental_telemetry.tracer`. Registering the provider as the global OTel singleton is unnecessary and carries two risks in V8 isolate runtimes:

| Risk                                             | Consequence                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Polluting the global OTel singleton              | Other OTel users in the same module scope observe unexpected state                               |
| State leakage across requests sharing an isolate | A provider created for one request's credentials could intercept spans from a subsequent request |

---

#### Instrumentation Scope Name

The tracer is obtained with the instrumentation scope name `'ai'`.

This value is **not a label** — it is a functional requirement. Langfuse's ingestion processor gates its AI SDK token-usage processing path on `instrumentationScopeName === 'ai'`. Any other scope name routes token counts through the generic OTel path, which silently omits AI SDK-specific token fields from Langfuse's structured usage data.

---

#### Span Processor Wiring

| Processor             | Behavior                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SimpleSpanProcessor` | Calls `exporter.export()` synchronously on each `span.end()`. No batch window, no background timer. One processor per exporter. |

`BatchSpanProcessor` is not used. It depends on a recurring background timer that does not survive isolate shutdown, causing spans to be silently dropped.

---

#### Resource Attributes

Every span exported by the provider carries the following resource attributes.

| Attribute                | Source                        | Notes                                                                  |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| `service.name`           | Configuration (`serviceName`) | Defaults to `'cloudflare-worker'`. Appears in Langfuse trace metadata. |
| `telemetry.sdk.name`     | OTel SDK                      | Populated automatically by the SDK.                                    |
| `telemetry.sdk.language` | OTel SDK                      | Populated automatically by the SDK.                                    |
| `telemetry.sdk.version`  | OTel SDK                      | Populated automatically by the SDK.                                    |

---

#### Context Manager Registration

The `@opentelemetry/context-async-hooks` package is an unconditional dependency. It is imported and the `AsyncLocalStorageContextManager` is registered at **module scope** — before any request handler fires. This means the `nodejs_compat` compatibility flag (or equivalent runtime support for `AsyncLocalStorage`) is a prerequisite for deploying with this package. Without `nodejs_compat`, the module-level import fails and the Worker does not start.

| Timing                             | Behavior                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Module load (cold start)           | `AsyncLocalStorageContextManager` is enabled and set as the global context manager. Runs exactly once per isolate lifetime.  |
| Subsequent requests (warm isolate) | Registration is already in place; no re-registration occurs.                                                                 |
| `nodejs_compat` absent             | Module import fails at load time; the Worker does not start. This is a deployment-time error, not a silent runtime fallback. |

Registration must occur at module scope, not inside a request handler or the factory body. Placing it inside per-request code means it runs after the first span may already have been created, and context propagation would be unreliable for that request.

For deployments that cannot enable `nodejs_compat`, context propagation is unavailable through this package. Single AI SDK calls per request still produce correct traces (each call gets its own trace), but multi-call grouping under one trace requires manual `context.with()` threading, which is outside the scope of this factory.

---

#### Root-Span Helper

The `rootSpan(name, attributes?)` helper creates a named span and activates it as the current context.

| Step                  | Observable behavior                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call `rootSpan(name)` | A new span is started with the given name and any provided attributes.                                                                                                                          |
| Returned `span`       | The caller is responsible for calling `span.end()` after the request completes, in a `finally` block.                                                                                           |
| Returned `ctx`        | An OTel `Context` object with the new span set as the active span.                                                                                                                              |
| Caller wraps handler  | `context.with(ctx, handler)` activates the context for the duration of `handler`. All AI SDK calls and `tracer.startActiveSpan()` calls inside `handler` inherit the root span as their parent. |

The root-span helper is designed for Hono middleware and plain Worker fetch handlers that need to parent all AI SDK spans under a single per-request root span.

---

#### Configuration

| Option        | Required | Default                      | Description                                                                                                                                                                                                                                                |
| ------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicKey`   | Yes      | —                            | Langfuse project public key. Used as the Basic Auth username in the `Authorization` header sent to the OTLP endpoint.                                                                                                                                      |
| `secretKey`   | Yes      | —                            | Langfuse project secret key. Used as the Basic Auth password.                                                                                                                                                                                              |
| `baseUrl`     | No       | `https://cloud.langfuse.com` | Base URL of the OTLP endpoint. Use `https://us.cloud.langfuse.com` for the US region, `https://hipaa.cloud.langfuse.com` for the HIPAA region, or a self-hosted domain. The endpoint path `{baseUrl}/api/public/otel/v1/traces` is appended automatically. |
| `serviceName` | No       | `'cloudflare-worker'`        | Value of the `service.name` resource attribute. Appears in Langfuse trace metadata.                                                                                                                                                                        |

---

#### Error Scenarios

| Scenario                                                 | Factory behavior                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `publicKey` is absent or empty                           | The factory produces a handle, but every `forceFlush()` call results in an HTTP 401 response; spans are dropped and a warning is logged. |
| `secretKey` is absent or empty                           | Same as above.                                                                                                                           |
| `baseUrl` is malformed                                   | `flush()` rejects the `fetch()` call; the error is caught, a warning is logged, and spans are dropped. `flush()` still resolves.         |
| `rootSpan()` called before context manager is registered | The span is created without an active parent; it becomes a root span as expected. No error is thrown.                                    |
| `flush()` called with an empty buffer                    | Resolves immediately; no HTTP request is made.                                                                                           |

---

### Context Propagation

Context propagation is how all AI SDK calls within one request are grouped under a single Langfuse trace rather than appearing as separate unrelated traces. This section defines both available propagation patterns and when each applies. See User Journeys 2 and 7 for the corresponding end-to-end flows.

---

#### How Context Inheritance Works

OpenTelemetry carries trace identity in a `Context` object. When an AI SDK call starts a new span, it reads the currently active context via `context.active()` to determine its parent. If the active context holds a live span, the new span inherits that span's `traceId` and records the parent's `spanId` as its `parentSpanId`. If no span is active, the AI SDK call starts a fresh root span with a new, unrelated `traceId`.

| Active context at call time | Result                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No active span              | AI SDK call becomes a new root span with its own `traceId` — appears as a separate trace in Langfuse         |
| Active span present         | AI SDK call inherits the active span's `traceId` and becomes a child — appears under the same Langfuse trace |

The `experimental_telemetry.tracer` option controls which provider records the span, but has no effect on parentage. Parentage is determined solely by the active context at the moment the span is started.

---

#### Propagation with `AsyncLocalStorage` (requires `nodejs_compat`)

_Corresponds to User Journey 2._

When `AsyncLocalStorageContextManager` is registered at module scope (see Provider Factory — Context Manager Registration), the OTel context flows automatically across all `await` boundaries within a request.

| Step                             | Observable behavior                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module load                      | `AsyncLocalStorageContextManager` is enabled once. All subsequent spans on any async execution path can read the active context automatically.                     |
| Root span creation               | The developer creates a root span via `rootSpan(name, attributes?)` and receives the span and an activated context object.                                         |
| Context activation               | The developer passes the context to `context.with(ctx, handler)`. For the duration of `handler`, the root span is the active context on that async execution path. |
| AI SDK calls inside handler      | Each call reads `context.active()`, finds the root span, and becomes a child. No per-call wrapping is needed.                                                      |
| Manual spans inside handler      | `tracer.startActiveSpan()` calls also inherit the root span as parent without any extra configuration.                                                             |
| Parallel calls via `Promise.all` | All parallel branches spawned inside the `context.with(ctx, handler)` scope inherit the root span's context automatically.                                         |

This pattern requires the `nodejs_compat` compatibility flag in `wrangler.toml`. Without it, the module-level import of `@opentelemetry/context-async-hooks` fails and the Worker does not start.

---

#### Manual Context Threading (without `nodejs_compat`)

_Corresponds to User Journey 7._

When `AsyncLocalStorage` is unavailable, context does not propagate automatically across `await` boundaries. Each AI SDK call must be individually wrapped to receive the parent context.

| Step                             | Observable behavior                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root span creation               | The developer creates a root span and holds a reference to it.                                                                                                                                                                                           |
| Per-call wrapping                | Each AI SDK call is wrapped in `context.with(ctx, () => call(...))` where `ctx` is a context derived from the root span. The AI SDK reads `context.active()` synchronously at span-start time, finds the root span, and records the parent relationship. |
| Sequential calls                 | Each call is wrapped individually. Calls execute one after the other; each receives the same root context.                                                                                                                                               |
| Parallel calls via `Promise.all` | Each parallel call is wrapped in its own `context.with(ctx, ...)`. Without per-branch wrapping, parallel branches do not inherit the root span and each starts a new trace.                                                                              |
| Calls without wrapping           | Any AI SDK call not wrapped in `context.with(ctx, ...)` starts a new root span with an independent `traceId` and appears as a separate trace in Langfuse.                                                                                                |

This pattern requires no additional dependencies or compatibility flags. It is more verbose than the `AsyncLocalStorage` pattern but produces identical trace output in Langfuse.

---

#### Pattern Selection

| Scenario                                                          | Pattern                                                                                                                                               | `nodejs_compat` required |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Single AI SDK call per request                                    | Pass `tracer` directly; no propagation needed                                                                                                         | No                       |
| Multiple sequential calls, grouped under one trace                | `AsyncLocalStorage` + middleware root span                                                                                                            | Yes                      |
| Multiple sequential calls, `nodejs_compat` unavailable            | Manual `context.with()` per call                                                                                                                      | No                       |
| Parallel calls via `Promise.all`, with `nodejs_compat` enabled    | All parallel branches spawned inside the outer `context.with(ctx, handler)` scope inherit context automatically; no per-branch wrapping needed        | Yes                      |
| Parallel calls via `Promise.all`, without `nodejs_compat` enabled | Each parallel call must be individually wrapped in `context.with(ctx, ...)` — without per-branch wrapping each branch starts an independent new trace | No                       |

---

#### Resulting Trace Structure in Langfuse

All spans sharing a `traceId` are grouped by Langfuse into a single Trace entity. The observation tree is determined by the `parentSpanId` relationships in the exported spans.

| Condition                                                | Langfuse outcome                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| All AI SDK calls share a `traceId`                       | A single Trace appears; the root span is the top-level observation; AI SDK spans appear as children   |
| `ai.generateText` and `ai.generateText.doGenerate` spans | Classified as `generation` observations; token usage appears on each                                  |
| Token usage across multiple calls                        | Rolled up across all `generation` observations within the Trace                                       |
| One call throws an exception                             | That `generation` observation is marked `ERROR`; the Trace-level severity is also elevated to `ERROR` |
| AI SDK calls have different `traceId`s (no propagation)  | Each call appears as a separate, unrelated Trace in Langfuse; no token roll-up across calls           |

The root span's attributes (for example `langfuse.trace.userId`, `langfuse.trace.sessionId`) propagate to the Trace entity metadata. These attributes should be set on the root span before it ends.

---

<!-- Remaining Behavior and Refinement sections to follow -->
