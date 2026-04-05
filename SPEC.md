# edge-otel-ts Specification

## Intent

### Purpose

V8 isolate runtimes (Cloudflare Workers, Vercel Edge Functions, Deno Deploy) cannot export OpenTelemetry traces. The Node.js OTel SDK depends on platform APIs that V8 isolates do not provide.

**Problem: Node.js OTel SDK is incompatible with V8 isolate runtimes**

| Missing capability                                            | Effect on OTel SDK                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `node:perf_hooks` absent or mocked (returns `timeOrigin = 0`) | Span timestamps silently corrupt — wrong values, no error thrown                               |
| `node:async_hooks` absent without `nodejs_compat` flag        | Context propagation fails; each AI SDK call starts a new unrelated trace                       |
| `node:http` / `node:https` absent                             | HTTP and gRPC exporters cannot open connections                                                |
| No TCP sockets                                                | gRPC transport is unavailable; all outbound I/O must use `fetch()`                             |
| No background timers that survive request end                 | `BatchSpanProcessor` drops all buffered spans when the isolate exits                           |
| No shared state across requests                               | Module-level OTel singletons cannot be assumed to persist; global registry risks state leakage |

**Problem: All existing solutions for OTel on Edge runtimes fail**

| Solution                                     | Failure mode                                                                                                                                             | Status                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@opentelemetry/sdk-node`                    | Depends on `node:perf_hooks`, `node:async_hooks`, `node:http` — absent or broken in V8 isolates                                                          | Broken in V8 isolates                                          |
| `@langfuse/otel` + `@opentelemetry/sdk-node` | Build error (`Could not resolve "perf_hooks"`) or runtime error (`Cannot convert object to primitive value`) from `sdk-trace-node` transitive dependency | Broken in V8 isolates                                          |
| `langfuse-vercel`                            | Same transitive dependency on `sdk-trace-node` via `@ai-sdk/otel`                                                                                        | Deprecated August 2025; broken in V8 isolates                  |
| `@microlabs/otel-cf-workers`                 | Instruments HTTP and CF bindings, not the AI SDK span tree; RC status; larger surface area than required                                                 | Viable for general observability; wrong fit for AI SDK tracing |
| Cloudflare automatic tracing                 | Captures infrastructure spans only; does not capture `ai.generateText`, `ai.streamText`, or `ai.toolCall` spans emitted by the AI SDK                    | Complementary, not a substitute                                |

`@aotoki/edge-otel` is a correct OTel SDK for Edge/Serverless runtimes. It builds on `sdk-trace-base` (not `sdk-trace-node`) and exports using only Web Platform APIs (`fetch()`, `btoa()`, `crypto`, `JSON`). Langfuse is one supported backend; any OTLP/HTTP endpoint is a valid target.

---

### Users

**Primary: Application developers** deploying Vercel AI SDK workloads to serverless runtimes

| User                            | Context                                                                                                         | Need                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cloudflare Workers developer    | Building AI features with Hono or plain Worker handlers; any OTLP/HTTP collector (e.g. Langfuse) as the backend | OTel traces from AI SDK calls export to any OTLP/HTTP collector without Node.js SDK dependencies |
| Deno Deploy developer           | Same AI SDK stack; Deno's `node:async_hooks` compat available                                                   | Same trace export without platform-specific changes                                              |
| Vercel Edge Functions developer | V8 isolate model identical to Cloudflare Workers; same runtime constraints apply                                | Same trace export without platform-specific changes                                              |

**Non-users (out of scope)**

| Excluded user                                                  | Reason                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js server developers                                      | Standard `@opentelemetry/sdk-node` works correctly on Node.js regardless of backend; `@langfuse/otel` is one option for Langfuse-specific setups |
| Developers needing gRPC / protobuf export                      | Not supported; OTLP/HTTP + JSON is sufficient for all major OTel collectors                                                                      |
| Developers instrumenting CF bindings (KV, D1, Durable Objects) | Out of scope; `@microlabs/otel-cf-workers` covers that use case                                                                                  |

---

### Impacts

**Before this package exists**

| Scenario                                                                                               | Outcome                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer follows standard Node.js OTel setup (e.g. NodeSDK + backend processor) on Cloudflare Workers | Build fails or spans are silently dropped; no traces reach the collector                                                                                                                                       |
| Developer enables `nodejs_compat` and retries                                                          | `perf_hooks` polyfill returns `timeOrigin = 0`; all span timestamps are wrong; failure is silent                                                                                                               |
| Developer uses `@microlabs/otel-cf-workers` pointed at an OTLP/HTTP endpoint (e.g. Langfuse)           | HTTP and CF binding spans export correctly; AI SDK spans (`ai.generateText`, etc.) do not appear because the AI SDK requires a registered `TracerProvider` with a `tracer` passed via `experimental_telemetry` |

**After this package exists**

| Capability                                                                        | State                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AI SDK spans export to any configured OTLP/HTTP collector from Cloudflare Workers | Supported                                                                                |
| Multiple AI SDK calls within one request grouped under one trace in the collector | Supported — requires `nodejs_compat` flag for multi-call grouping                        |
| Custom application spans (RAG retrieval, DB queries) included in the same trace   | Supported                                                                                |
| Span export completes after the HTTP response is sent                             | Supported — isolate lifetime is extended until export resolves                           |
| Thrown exceptions from AI SDK calls are marked as `ERROR` in the exported trace   | Supported — no manual error annotation required                                          |
| Target backend is swappable to any OTLP/HTTP + JSON collector                     | Supported — URL and credentials are runtime configuration, not compile-time dependencies |
| Timestamps are correct in V8 isolates                                             | Supported — does not depend on `node:perf_hooks`                                         |

## Scope

### Feature List

| #   | Feature                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OTLP/HTTP JSON span exporter using only Web Platform APIs (`fetch`, `btoa`, `crypto`) — no Node.js built-ins required                   |
| 2   | OTLP/HTTP + JSON span exporter targeting any compatible collector; Langfuse is a supported backend with dedicated configuration helpers |
| 3   | `SimpleSpanProcessor` for per-span buffering with explicit flush via `forceFlush()` — no background timer dependency                    |
| 4   | `AsyncLocalStorage`-based context propagation that groups all AI SDK calls within a single request under one trace                      |
| 5   | Automatic error tracking: thrown exceptions are recorded as span events and marked `ERROR` status without manual instrumentation        |
| 6   | Manual span creation via the standard OTel `Tracer` API for custom instrumentation (RAG retrieval, database queries, etc.)              |
| 7   | Hono middleware for root span lifecycle management: span creation, context activation, error capture, and flush registration            |

---

### IS / IS NOT

| IS                                                                                                                         | IS NOT                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A standard OTel `SpanExporter` implementation on top of `sdk-trace-base`                                                   | A full OTel SDK reimplementation from scratch                                                                 |
| Cloudflare Workers as the primary target runtime, portable to Deno Deploy and Vercel Edge by design                        | Node.js server support (`@langfuse/otel` + `@opentelemetry/sdk-node` already handles that)                    |
| Any OTLP/HTTP + JSON collector as the export target; Langfuse is one supported backend with dedicated integration guidance | gRPC or protobuf transport support                                                                            |
| `AsyncLocalStorage`-based context propagation for multi-call trace merging (requires `nodejs_compat` flag)                 | Automatic propagation without the `nodejs_compat` flag                                                        |
| Automatic `ERROR` status when exceptions are thrown by AI SDK calls                                                        | Automatic `WARNING` status for soft failures (`finishReason = "error"`) — that remains manual                 |
| Manual spans via the standard OTel `Tracer` API                                                                            | Auto-instrumentation of Cloudflare bindings (KV, D1, Durable Objects)                                         |
| Minimal dependency surface: 4 OTel packages only                                                                           | Dependency on `@opentelemetry/sdk-node`, `@langfuse/otel`, `langfuse-vercel`, or `@microlabs/otel-cf-workers` |

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
| **Context** | A developer has one `generateText` or `streamText` call per Worker request handler and wants it to appear as a trace in the configured collector.                                                                                               |
| **Action**  | The developer configures the provider with the collector endpoint and credentials, passes the resulting tracer to `experimental_telemetry.tracer` on the AI SDK call, and registers the flush with `ctx.waitUntil` before returning the response. |
| **Outcome** | A single trace appears in the configured collector containing the AI SDK span tree (`ai.generateText`, `ai.generateText.doGenerate`) with correct timestamps, token usage, and model attributes.                                                   |

---

**Journey 2: Multiple AI SDK calls grouped under one trace**

|             |                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer makes multiple sequential `generateText` or `streamText` calls within one request (for example, summarise → translate → format) and wants all calls to appear as one trace rather than separate unrelated traces.                                                                         |
| **Action**  | The developer enables the `nodejs_compat` compatibility flag, uses the Hono middleware (or a plain Cloudflare Workers fetch handler with the same root-span pattern) to create a root span and activate it as the request context, then passes the tracer to each AI SDK call within the same request handler. |
| **Outcome** | All AI SDK spans from the request share a single `traceId` and appear as sibling children under the root span in one trace in the collector.                                                                                                                                |

---

**Journey 3: Custom instrumentation alongside AI SDK calls**

|             |                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer wants RAG retrieval steps, database queries, or other application-level operations to appear as spans in the same trace as the AI SDK calls.                         |
| **Action**  | The developer uses the tracer returned by the provider factory to create manual spans for the custom operations, keeping them within the same active request context as the AI SDK calls. |
| **Outcome** | Custom spans appear as siblings alongside the AI SDK spans under the same root trace in the collector, giving a complete end-to-end view of the request.                                       |

---

**Journey 4: Automatic error observation**

|             |                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call throws an exception — such as an API authentication error, rate limit response, or network timeout — during request processing.                               |
| **Action**  | No manual action is required; the AI SDK records the exception on the span and sets the span status to ERROR before re-throwing.                                             |
| **Outcome** | The span is marked ERROR with the exception type, message, and stack trace recorded as a span event; the error observation is visible in the collector. |

---

**Journey 5: Soft error warning (manual)**

|             |                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call returns successfully (no exception thrown) but `finishReason` is `"error"` or `"content-filter"`, indicating the generation was not completed as expected.                                               |
| **Action**  | After the AI SDK call returns, the developer inspects `finishReason` and sets the span status or backend-specific attributes to signal the soft failure. |
| **Outcome** | The span status reflects the soft failure and the observation is visible in the collector. Backend-specific signaling (e.g., `langfuse.observation.level`) is documented in the backend integration guide.                                    |

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
| **Context** | A developer cannot enable the `nodejs_compat` flag (due to policy or binary size constraints) but still wants multiple AI SDK calls within one request to share a single trace.         |
| **Action**  | The developer creates a root span manually and wraps each AI SDK call individually in an explicit `context.with()` call that sets the root span as the active context immediately before each call. |
| **Outcome** | All AI SDK calls inherit the root span's `traceId` via manual context threading and appear as children under the same trace in the collector, without requiring `AsyncLocalStorage`.                        |

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

### Middleware

The middleware component manages the root span lifecycle for a complete request: it creates a root span, activates the request context, handles errors, ends the span, and registers the flush. It is the entry point for User Journey 2 (multiple AI SDK calls grouped under one trace).

The middleware is available in two variants: one for Hono applications and one for plain Cloudflare Workers fetch handlers. Both variants produce identical trace output; they differ only in how they access the execution context and request information.

---

#### Middleware Lifecycle

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

#### Root Span Attributes

The middleware records the following on the root span at creation time.

| Attribute source        | Behavior                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Span name               | Configurable at middleware setup time. Defaults to `http.request` if not overridden.                                                                                                       |
| Custom attributes       | Any `Record<string, string>` attributes provided to the middleware configuration are set on the root span at creation.                                                                     |
| Langfuse trace metadata | Attributes such as `langfuse.user.id` and `langfuse.session.id` can be set on the root span by the application before the span ends; they propagate to the Langfuse Trace entity metadata. |

---

#### Flush Timing

The ordering of operations is a correctness requirement, not a style preference.

| Rule                                                                   | Rationale                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitUntil(flush())` is registered BEFORE the response is returned     | `waitUntil` must be called while the execution context is still active. Calling it after the response object is constructed but before `return` is the only safe window.                           |
| The flush promise must resolve within the 30-second `waitUntil` budget | The runtime terminates all `waitUntil` promises after 30 seconds of wall-clock time post-response. A flush that takes longer than 30 seconds will be aborted and spans will be lost.               |
| `flush()` never rejects                                                | If the flush promise rejects, the `waitUntil` chain is interrupted and the runtime may terminate the isolate in an undefined state. All flush errors are caught internally and logged as warnings. |

---

#### streamText Special Case

`streamText` responses require different flush sequencing than `generateText` responses.

| Condition                                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Response is a non-streaming `generateText` result | Flush is registered immediately after the handler returns, before the response is sent. All AI SDK spans have already ended when the handler returns.                                                                                                                                                                                                                                                                                    |
| Response is a `streamText` result                 | The AI SDK ends the streaming spans (`ai.streamText`, `ai.streamText.doStream`) only after the response stream is fully consumed by the client. The AI SDK result exposes a `consumedStream` promise that resolves when the stream is fully consumed. Flush must be chained after `consumedStream` resolves. If flush fires before `consumedStream` resolves, the streaming spans have not yet ended and will be absent from the export. |

When the handler returns a streaming response, the middleware chains the flush after `consumedStream` resolves rather than immediately in the unconditional cleanup phase. This ensures all streaming spans, including token usage and finish reason, are present in the buffer before the flush POST is made.

---

#### Hono Variant

| Integration point    | Behavior                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Middleware signature | Conforms to Hono's standard middleware signature, receiving Hono's context and a `next` function.                                                           |
| Execution context    | The flush is registered via the execution context exposed by the framework's request context object.                                                        |
| Request information  | HTTP method, URL, and route path are available from Hono's context and can be set as root span attributes at middleware setup time.                         |
| Tracer availability  | The tracer is made available to route handlers via Hono's context variable store so each handler can pass it to AI SDK calls without constructor threading. |

---

#### Plain Cloudflare Workers Fetch Handler Variant

| Integration point    | Behavior                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Handler signature    | Works with the standard `export default { fetch(request, env, ctx) }` pattern. No framework dependency.               |
| Execution context    | The flush is registered via `ctx.waitUntil(flush())` using the `ctx` parameter of the fetch handler directly.         |
| Request information  | HTTP method and URL are available from the `Request` object and can be set as root span attributes.                   |
| Environment bindings | The provider factory is called inside the fetch handler body where `env` bindings are available, not at module scope. |

---

#### Error Scenarios

| Scenario                           | Middleware behavior                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler throws                     | The exception is recorded on the root span via `recordException`; the root span status is set to ERROR; the root span is ended; the flush is registered; the exception is re-thrown to the runtime unchanged. |
| `flush()` fails internally         | The error is caught inside the flush function and logged as a warning; the response is unaffected; the flush promise resolves rather than rejects so the `waitUntil` chain completes cleanly.                 |
| `waitUntil` budget exceeded (30 s) | The runtime terminates the isolate; any in-flight flush POST request is aborted by the runtime; the spans from that request are lost. This is an infrastructure constraint, not a middleware failure.         |
| Root span creation fails           | This indicates an internal OTel SDK error; the middleware does not suppress it. The downstream handler is not invoked.                                                                                        |

### Langfuse Semantic Mapping

This section defines the rules by which Langfuse interprets OTLP spans received at its ingestion endpoint. An implementer must follow these rules precisely — most failures are silent (no HTTP error, no warning in the Langfuse UI) and produce incorrect or absent data rather than a visible error.

---

#### Data Model

Every batch of OTLP spans arriving at Langfuse maps onto two entity layers.

| OTLP concept                        | Langfuse entity                                   | Rule                                                                                                       |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| All spans sharing a `traceId`       | One **Trace**                                     | Langfuse groups by `traceId`; each unique `traceId` produces exactly one Trace.                            |
| Span with no `parentSpanId`         | Trace-level observation; source of Trace metadata | The root span is the authoritative source for `userId`, `sessionId`, `tags`, `release`, and `environment`. |
| Span with a `parentSpanId`          | Child **Observation** within the Trace            | `parentSpanId` becomes `parentObservationId` in Langfuse.                                                  |
| Span classified as a generation     | **Generation** observation sub-type               | Has additional fields: `model`, `modelParameters`, `usage`, `cost`, `completionStartTime`.                 |
| Span not classified as a generation | **Span** observation sub-type                     | Generic unit of work; no model or token fields.                                                            |

Langfuse Trace fields (`id`, `name`, `userId`, `sessionId`, `tags`, `release`, `environment`) are populated only from the root span and from spans carrying explicit `langfuse.trace.*` attributes. Attributes on child spans do not propagate up to the Trace entity.

---

#### Generation Detection

Langfuse runs `ObservationTypeMapperRegistry` to decide whether each span is a Generation or a plain Span. Mappers execute in priority order; the first match wins.

| Priority     | Condition                                                                                                                   | Classified as |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1            | `langfuse.observation.type` = `"generation"`                                                                                | Generation    |
| 2            | `openinference.span.kind` = `"LLM"`                                                                                         | Generation    |
| 3            | `gen_ai.operation.name` = `"chat"`, `"completion"`, `"text_completion"`, or `"generate_content"`                            | Generation    |
| 4            | Span name starts with `ai.generateText.doGenerate` or `ai.streamText.doStream` **and** instrumentation scope name is `'ai'` | Generation    |
| 5 (fallback) | Any model name attribute (see Model Name Resolution) is present on the span                                                 | Generation    |
| default      | None of the above conditions are met                                                                                        | Span          |

The instrumentation scope name in `scopeSpans[].scope.name` **must be exactly `'ai'`** for the priority 4 path to match. Any other value — including `'@ai-sdk/openai'`, `'vercel-ai'`, or a custom name — causes the mapper to skip priority 4. When priority 4 is skipped, the span may still be classified as a generation via the model-based fallback at priority 5, but the AI SDK–specific token-usage extraction path does not run and token counts are not populated in the structured `usage` field.

---

#### Token Usage Attribute Keys

Token counts are mapped to the Generation `usage` field only when the instrumentation scope name is `'ai'` and the correct attribute keys are used.

| Attribute key                    | Langfuse `usage` field                   | Applies to scope                   |
| -------------------------------- | ---------------------------------------- | ---------------------------------- |
| `gen_ai.usage.input_tokens`      | `usage.input` (prompt tokens)            | `'ai'` scope and all other scopes  |
| `gen_ai.usage.output_tokens`     | `usage.output` (completion tokens)       | `'ai'` scope and all other scopes  |
| `gen_ai.usage.prompt_tokens`     | `usage.input` (backward compat)          | `'ai'` scope and all other scopes  |
| `gen_ai.usage.completion_tokens` | `usage.output` (backward compat)         | `'ai'` scope and all other scopes  |
| `ai.usage.tokens`                | `usage.total`                            | `'ai'` scope only                  |
| `ai.usage.cachedInputTokens`     | `usage.cachedInputTokens`                | `'ai'` scope only                  |
| `ai.usage.reasoningTokens`       | `usage.reasoningTokens`                  | `'ai'` scope only (Langfuse v3.x+) |
| `ai.usage.promptTokens`          | **not mapped** — stored in metadata only | —                                  |
| `ai.usage.completionTokens`      | **not mapped** — stored in metadata only | —                                  |

`ai.usage.promptTokens` and `ai.usage.completionTokens` (camelCase keys emitted by AI SDK versions below 4.0) are **not** read by Langfuse's structured token path. They are stored in the observation's raw metadata only and do not populate the `usage` fields visible in the Langfuse UI. Use `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` for all structured token reporting.

---

#### Model Name Resolution

Langfuse checks the following attribute keys in priority order; the first non-empty value populates the Generation's `model` field.

| Priority | Attribute key                     | Source                                             |
| -------- | --------------------------------- | -------------------------------------------------- |
| 1        | `langfuse.observation.model.name` | Langfuse-native override                           |
| 2        | `gen_ai.request.model`            | OTel GenAI semantic convention — requested model   |
| 3        | `gen_ai.response.model`           | OTel GenAI semantic convention — actual model used |
| 4        | `ai.model.id`                     | Vercel AI SDK primary identifier                   |
| 5        | `llm.response.model`              | OpenLLMetry / older conventions                    |

For AI SDK spans, `gen_ai.request.model` is the preferred key. `gen_ai.response.model` is appropriate when the provider returns a different model name from what was requested (e.g., model aliases).

---

#### Trace Metadata Attributes

The following span attributes are read by Langfuse to populate Trace and Observation fields. Attributes in the `langfuse.*` namespace take priority over equivalent keys from other namespaces.

| Attribute key                           | Langfuse field                   | Value type                                     | Applies to |
| --------------------------------------- | -------------------------------- | ---------------------------------------------- | ---------- |
| `langfuse.user.id`                      | `trace.userId`                   | String                                         | Root span  |
| `langfuse.session.id`                   | `trace.sessionId`                | String                                         | Root span  |
| `langfuse.trace.tags`                   | `trace.tags`                     | `arrayValue` of strings                        | Root span  |
| `langfuse.trace.input`                  | `trace.input`                    | String or JSON                                 | Root span  |
| `langfuse.trace.output`                 | `trace.output`                   | String or JSON                                 | Root span  |
| `langfuse.trace.metadata.*`             | `trace.metadata.*`               | String                                         | Any span   |
| `langfuse.observation.input`            | `observation.input`              | String or JSON                                 | Any span   |
| `langfuse.observation.output`           | `observation.output`             | String or JSON                                 | Any span   |
| `langfuse.observation.metadata.*`       | `observation.metadata.*`         | String                                         | Any span   |
| `langfuse.observation.level`            | `observation.level`              | `"DEBUG"`, `"DEFAULT"`, `"WARNING"`, `"ERROR"` | Any span   |
| `langfuse.observation.status_message`   | `observation.statusMessage`      | String                                         | Any span   |
| `langfuse.observation.type`             | `observation.type`               | `"generation"`, `"span"`, `"event"`            | Any span   |
| `langfuse.observation.usage_details`    | `observation.usage`              | JSON-encoded usage object                      | Any span   |
| `langfuse.observation.model.name`       | `observation.model`              | String                                         | Any span   |
| `langfuse.observation.model.parameters` | `observation.modelParameters`    | JSON-encoded object                            | Any span   |
| `langfuse.prompt.name`                  | `observation.promptName`         | String                                         | Any span   |
| `langfuse.prompt.version`               | `observation.promptVersion`      | Integer                                        | Any span   |
| `langfuse.internal.as_root`             | Forces span to act as trace root | Boolean `true`                                 | Any span   |

---

#### Environment and Release

Resource attributes (set on the `resource.attributes` of the OTLP payload, not on individual spans) control environment and release fields on every Trace in the export batch.

| Resource attribute            | Langfuse field                 |
| ----------------------------- | ------------------------------ |
| `service.version`             | `trace.release`                |
| `deployment.environment.name` | `trace.environment`            |
| `deployment.environment`      | `trace.environment` (fallback) |

---

#### Model Parameters Extraction

Generation `modelParameters` are populated from the following span attributes.

| Attribute key                | `modelParameters` field   |
| ---------------------------- | ------------------------- |
| `gen_ai.request.temperature` | `temperature`             |
| `gen_ai.request.max_tokens`  | `maxTokens`               |
| `ai.settings.maxSteps`       | `maxSteps` (AI SDK scope) |

`langfuse.observation.model.parameters` accepts a JSON-encoded object and overrides all individual `gen_ai.request.*` attributes when present.

---

#### Observation Level and Error Mapping

The `level` field on an observation is determined in the following order.

| Priority | Source                                                     | Values                                         |
| -------- | ---------------------------------------------------------- | ---------------------------------------------- |
| 1        | `langfuse.observation.level` attribute (explicit override) | `"DEBUG"`, `"DEFAULT"`, `"WARNING"`, `"ERROR"` |
| 2        | `span.status.code` = `2` (ERROR) → inferred                | `"ERROR"`                                      |
| 3        | `span.status.code` = `0` or `1` → default                  | `"DEFAULT"`                                    |

The `statusMessage` field is set from `langfuse.observation.status_message` (priority 1) or `span.status.message` (priority 2).

---

#### Behavioral Rules

The following rules govern situations where incorrect attribute usage produces silent failures. Each rule is a correctness requirement, not a recommendation.

| #   | Rule                                                                                                                                                                                                                  | Consequence of violation                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Instrumentation scope name **must be `'ai'`** for the Vercel AI SDK token-usage path to run. Any other scope name disables the `'ai'`-specific extraction.                                                            | Token counts are not populated in the Generation `usage` field; they are stored in raw metadata only.   |
| 2   | Token usage attributes (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) **must be on the same span** as the model name attribute. Langfuse does not aggregate usage across spans.                          | The generation appears with no token usage; cross-span aggregation does not occur.                      |
| 3   | `langfuse.trace.tags` **must use `arrayValue` format** — an OTel array attribute with string elements. A plain `stringValue` is not parsed as a tag list.                                                             | Tags are stored in observation metadata only; they do not appear as filterable tags in the Langfuse UI. |
| 4   | `langfuse.observation.level` **overrides** the level inferred from `span.status.code`. Setting it to `"DEFAULT"` on a span with `status.code = 2` (ERROR) suppresses the ERROR level in Langfuse.                     | The observation level in Langfuse does not match the OTel span status.                                  |
| 5   | A root span (no `parentSpanId`) **must be present** in every export batch for Langfuse to build the Trace entity correctly. Trace-level fields (`userId`, `sessionId`, `tags`) are only extracted from the root span. | Langfuse cannot fully construct the Trace entity; trace-level metadata fields are absent.               |
| 6   | The `x-langfuse-ingestion-version: 4` request header **must be sent** with every OTLP POST. Without it, spans are processed via the legacy pipeline.                                                                  | Spans may be delayed up to 10 minutes before appearing in the Langfuse Cloud UI.                        |
| 7   | `ai.usage.promptTokens` and `ai.usage.completionTokens` (camelCase AI SDK legacy keys) are **not** read by the structured token path.                                                                                 | Token counts from older AI SDK spans are absent from the Generation `usage` field.                      |
| 8   | Unknown `gen_ai.usage.*` sub-keys on spans targeting Langfuse instances **older than v3.x** cause the entire span to be dropped from the UI.                                                                          | Affected spans disappear silently from the Langfuse UI on older self-hosted instances.                  |

### Error Handling

This section defines how errors surface through the system — from an AI SDK provider call to a Langfuse observation. It covers three distinct error categories, the automatic handling path for thrown exceptions, the gap for soft errors, and the isolation of telemetry failures from the application. See User Journeys 4 and 5 for the corresponding end-to-end flows.

---

#### Error Categories

| Category                        | Source                                        | Example                                                                         | Handling                                                                                                                                         |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hard errors (thrown exceptions) | AI SDK provider calls                         | API authentication failure, rate limit exhausted, network timeout, server error | Automatic — the AI SDK records the exception on the span and sets `status.code = ERROR` before re-throwing; no developer action needed           |
| Soft errors (non-thrown)        | AI SDK returns with a terminal `finishReason` | `finishReason = "error"` or `"content-filter"`                                  | Manual — the developer must inspect `finishReason` after the call returns and set `langfuse.observation.level` to `"WARNING"` on the active span |
| Export errors                   | Exporter flush                                | Network failure during POST, HTTP 4xx, payload exceeds 4.5 MB                   | Automatic — logged as a warning and spans are dropped; the application is never notified                                                         |

---

#### Automatic Error Handling for Thrown Exceptions

_Corresponds to User Journey 4._

The AI SDK wraps every provider call in an internal span helper. When a provider call throws for any reason, the following happens before the exception propagates to the application:

| Step                                       | Observable outcome                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exception caught by the AI SDK span helper | `recordException(error)` is called — an `"exception"` event is added to the span with `exception.type`, `exception.message`, and `exception.stacktrace`                             |
| Span status set                            | `status.code` is set to `2` (ERROR) with `status.message` set to the error message                                                                                                  |
| Both inner and outer spans marked          | The inner span (e.g., `ai.generateText.doGenerate`) and the outer span (e.g., `ai.generateText`) both receive ERROR status — the exception propagates up through the span hierarchy |
| Exception re-thrown                        | The original exception is re-thrown unchanged to the application's `try/catch`                                                                                                      |

No configuration or manual instrumentation is required for this path. The exporter forwards `status.code` and the exception events as part of the standard OTLP payload, and Langfuse maps `status.code = 2` to `level = "ERROR"` automatically.

---

#### AI SDK Error Types

All AI SDK error classes result in `status.code = 2` on the enclosing span. The `exception.type` attribute in the exception event identifies the failure mode without requiring message parsing.

| Error class                        | Trigger                                                                                              | Span status                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AI_APICallError`                  | HTTP 4xx or 5xx response from the provider (rate limit, auth failure, invalid request, server error) | ERROR — exception recorded on both inner (`doGenerate`) and outer (`generateText`) spans            |
| `AI_RetryError`                    | All retry attempts exhausted; wraps the last `AI_APICallError`                                       | ERROR — only the final failure outcome is visible; individual retry attempts do not appear as spans |
| `AI_LoadAPIKeyError`               | API key missing or not loadable at call time                                                         | ERROR — thrown before any provider span is created; the AI SDK root span reflects the error         |
| `AI_InvalidPromptError`            | Malformed prompt before any network call                                                             | ERROR                                                                                               |
| `AI_NoContentGeneratedError`       | Provider returned HTTP 200 but with empty content                                                    | ERROR                                                                                               |
| `AI_JSONParseError`                | Response body did not match the expected schema for structured output                                | ERROR                                                                                               |
| `AI_UnsupportedFunctionalityError` | Feature not supported by the chosen provider or model                                                | ERROR                                                                                               |

---

#### Retry Behavior and Span Visibility

The AI SDK retries transient failures internally (default: up to 2 retries, 3 total attempts). Retries are not individually observable in the span tree.

| Scenario                           | Span outcome                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Retry succeeds on a later attempt  | The `doGenerate` span ends with `status.code = 1` (OK); the intermediate failures leave no trace |
| All retries exhausted              | The `doGenerate` span ends with `status.code = 2` (ERROR) and `exception.type = "AI_RetryError"` |
| `ai.settings.maxRetries` attribute | Always present on the span, regardless of whether any retries occurred                           |

An implementer cannot distinguish a first-attempt success from a third-attempt success in the span data. A Langfuse observation marked ERROR for a `doGenerate` span means all retries were exhausted and the call ultimately failed — not that a single attempt failed.

---

#### Soft Error Gap

_Corresponds to User Journey 5._

When a provider returns HTTP 200 but signals a problem via the stream finish reason, the AI SDK may not throw an exception. This is a known gap in the AI SDK telemetry model.

| Condition                                                                | Span state                        | Langfuse level                               |
| ------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------- |
| `finishReason = "error"` — provider signals error via streaming protocol | `status.code` remains `0` (UNSET) | `"DEFAULT"` — the problem is silently hidden |
| `finishReason = "content-filter"` — content blocked mid-stream           | `status.code` remains `0` (UNSET) | `"DEFAULT"` — the problem is silently hidden |

The system does not detect soft errors automatically. To make a soft error visible in Langfuse, the developer inspects `finishReason` after the call returns and sets the Langfuse-specific attribute on the active span:

| Attribute                             | Value                                                             | Effect                                                          |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `langfuse.observation.level`          | `"WARNING"`                                                       | Overrides the inferred level for the observation in Langfuse    |
| `langfuse.observation.status_message` | Descriptive string (e.g., `"Generation stopped: content-filter"`) | Populates the `statusMessage` field on the Langfuse observation |

`langfuse.observation.level` is a Langfuse-proprietary span attribute. Setting it to `"WARNING"` does not change `span.status.code`, so other OTel backends (Jaeger, Grafana Tempo, Honeycomb) are not affected. To make the same failure visible to non-Langfuse backends, the span's OTel status must also be set to ERROR and the exception recorded — that path produces `level = "ERROR"` in Langfuse rather than `"WARNING"`, so the two approaches target different severity semantics.

---

#### Status Code to Langfuse Level Mapping

| `span.status.code`                                  | Value | Langfuse observation level                                     |
| --------------------------------------------------- | ----- | -------------------------------------------------------------- |
| UNSET                                               | 0     | `"DEFAULT"`                                                    |
| OK                                                  | 1     | `"DEFAULT"`                                                    |
| ERROR                                               | 2     | `"ERROR"`                                                      |
| (any, when `langfuse.observation.level` is present) | —     | Whatever value is set — takes priority over the inferred level |

`"WARNING"` and `"DEBUG"` levels in Langfuse can only be produced via the explicit `langfuse.observation.level` attribute. There is no `span.status.code` value that maps to either.

---

#### Trace-Level Error Propagation

Langfuse sets the trace-level `level` field to the highest severity among all observations in the trace.

| Condition                       | Trace-level outcome                                             |
| ------------------------------- | --------------------------------------------------------------- |
| All observations at `"DEFAULT"` | Trace level is `"DEFAULT"`                                      |
| Any observation at `"WARNING"`  | Trace level is `"WARNING"`                                      |
| Any observation at `"ERROR"`    | Trace level is `"ERROR"` regardless of other observation levels |

**Known risk**: In a multi-step agentic flow, a single failed `doGenerate` span — even one that was a transient failure in an otherwise successful request — marks the entire trace as `"ERROR"`. There is no built-in Langfuse mechanism to suppress a child observation's ERROR from propagating to the trace level. Alerting rules based on trace-level severity should account for this behavior.

---

#### Export Error Isolation

Telemetry failures are fully isolated from the application. This is a correctness requirement, not a best-effort policy.

| Rule                                                             | Rationale                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `forceFlush()` never rejects                                     | A rejecting promise interrupts the `ctx.waitUntil()` chain and leaves the Worker isolate in an undefined state |
| Export errors are logged as warnings                             | The application has no notification mechanism for telemetry failures; logging is the only observable signal    |
| Spans from a failed flush are dropped                            | No retry is attempted; the 30-second `waitUntil` budget is not sufficient for retry logic                      |
| The HTTP response is never delayed or altered by a flush failure | The flush executes after the response is returned, inside `ctx.waitUntil()`                                    |

Export error scenarios are fully specified in the OTLP Span Exporter — Error Scenarios table.

## Refinement

### Contracts & Types

This section defines the public API surface, the TypeScript interfaces that implement that surface, the wire format types that the serializer and any future implementer must produce identically, and the key terms used throughout this specification.

---

#### Public API Surface

The package exposes exactly the following identifiers at its public boundary. Internal types, helper functions, and the span processor wiring are not part of the public API.

| Export                  | Kind      | Purpose                                                                                             |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `createTracerProvider`  | Function  | Factory: accepts configuration and returns a `TracerHandle`                                         |
| `TracerHandle`          | Interface | The object returned by the factory; consumed by application code                                    |
| `TracerProviderOptions` | Interface | Configuration accepted by the factory; extends the exporter config with `serviceName`               |
| `ExporterConfig`        | Interface | Credentials and endpoint configuration for the OTLP exporter                                        |
| `LangfuseSpanExporter`  | Class     | The OTLP/HTTP JSON exporter; exported for advanced use (custom processor wiring, multiple backends) |
| `createHonoMiddleware`  | Function  | Returns a Hono middleware function that manages root span lifecycle for a complete Hono request     |

`LangfuseSpanExporter` is exported because implementers wiring multiple backends or a custom `SimpleSpanProcessor` need direct access to the exporter instance. It is not required for typical single-backend use.

---

#### Configuration Contract

`ExporterConfig` captures the credentials and endpoint needed to POST to a Langfuse OTLP ingestion endpoint.

| Field       | Type     | Required | Default                        | Description                                                                                                                                |
| ----------- | -------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicKey` | `string` | Yes      | —                              | Langfuse project public key (format: `pk-lf-…`). Used as the Basic Auth username in every OTLP POST request.                               |
| `secretKey` | `string` | Yes      | —                              | Langfuse project secret key (format: `sk-lf-…`). Used as the Basic Auth password.                                                          |
| `baseUrl`   | `string` | No       | `'https://cloud.langfuse.com'` | Base URL of the Langfuse deployment. The path `/api/public/otel/v1/traces` is appended automatically. Accepts any OTLP/HTTP JSON endpoint. |

`TracerProviderOptions` extends `ExporterConfig` with one additional field.

| Field         | Type     | Required | Default               | Description                                                                              |
| ------------- | -------- | -------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `serviceName` | `string` | No       | `'cloudflare-worker'` | Value of the `service.name` OTel resource attribute. Appears in Langfuse trace metadata. |

TypeScript interface:

```typescript
interface ExporterConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

interface TracerProviderOptions extends ExporterConfig {
  serviceName?: string;
}
```

---

#### Handle Contract

`TracerHandle` is the object returned by `createTracerProvider`. It contains every member an application needs to instrument AI SDK calls, create custom spans, and flush completed spans after the HTTP response is sent.

| Member     | Type                                                                                  | Purpose                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracer`   | `Tracer` (from `@opentelemetry/api`)                                                  | Pass to `experimental_telemetry.tracer` on every AI SDK call. Never registered globally; used exclusively via this reference.                                                                      |
| `flush`    | `() => Promise<void>`                                                                 | Drain the in-memory span buffer and POST all buffered spans to the configured endpoint. Register with `ctx.waitUntil(flush())` before returning the HTTP response. Always resolves; never rejects. |
| `rootSpan` | `(name: string, attributes?: Record<string, string>) => { span: Span; ctx: Context }` | Create a named root span with optional attributes. Returns the span and a context with that span set as active. Pass the returned `ctx` to `context.with(ctx, handler)`.                           |

TypeScript interface:

```typescript
interface TracerHandle {
  tracer: Tracer;
  flush: () => Promise<void>;
  rootSpan: (
    name: string,
    attributes?: Record<string, string>,
  ) => {
    span: Span;
    ctx: Context;
  };
}
```

`Tracer`, `Span`, and `Context` are from `@opentelemetry/api`. They are not redefined here; this package imports and re-uses the upstream types.

---

#### OTLP JSON Wire Format Types

The following types define the JSON structure that the serializer must produce. Two implementers given the same `ReadableSpan[]` input must emit byte-identical JSON (up to key ordering). These types are wire format contracts, not internal data structures.

**Attribute value wrapper** — every attribute value in OTLP JSON is wrapped in a typed envelope. Exactly one field is present per value.

```typescript
interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string; // decimal string — preserves 64-bit integer precision
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
```

**Span event** — an occurrence recorded on a span (e.g., an exception).

```typescript
interface OtlpEvent {
  name: string;
  timeUnixNano: string; // nanosecond decimal string
  attributes: OtlpKeyValue[];
  droppedAttributesCount: number;
}
```

**Span** — one unit of work.

```typescript
interface OtlpSpan {
  traceId: string; // 32-char lowercase hex
  spanId: string; // 16-char lowercase hex
  parentSpanId?: string; // 16-char lowercase hex; omitted for root spans
  name: string;
  kind: number; // 1=INTERNAL 2=SERVER 3=CLIENT 4=PRODUCER 5=CONSUMER
  startTimeUnixNano: string; // nanosecond decimal string
  endTimeUnixNano: string; // nanosecond decimal string
  attributes: OtlpKeyValue[];
  events: OtlpEvent[];
  status: { code: number; message?: string }; // 0=UNSET 1=OK 2=ERROR
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
}
```

**Grouping envelope** — spans are grouped by instrumentation scope, and scopes are grouped by resource.

```typescript
interface OtlpScopeSpans {
  scope: { name: string; version?: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: OtlpScopeSpans[];
}

interface ExportTraceServiceRequest {
  resourceSpans: OtlpResourceSpans[];
}
```

**Encoding rules that affect correctness** (violations produce silent bad data, not errors):

| Field               | Encoding rule                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `traceId`           | Lowercase hex string, exactly 32 characters                                                                      |
| `spanId`            | Lowercase hex string, exactly 16 characters                                                                      |
| `parentSpanId`      | Omitted entirely for root spans — an empty string is incorrect and causes backend rejection                      |
| `startTimeUnixNano` | Built by string concatenation: `"${seconds}${nanos.padStart(9, '0')}"` — arithmetic overflows `MAX_SAFE_INTEGER` |
| `endTimeUnixNano`   | Same rule as `startTimeUnixNano`                                                                                 |
| `intValue`          | Decimal string — token counts and other 64-bit counters may exceed `Number.MAX_SAFE_INTEGER`                     |
| `scope.name`        | Must be exactly `'ai'` for AI SDK spans — Langfuse gates token-usage extraction on this value                    |

---

#### Terminology

| Term                       | Definition                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handle                     | The object returned by `createTracerProvider`; contains `tracer`, `flush`, and `rootSpan`. The application holds this object and uses it for every AI SDK call and flush registration within a request.                      |
| Root span                  | The top-level span for a single request; created by the Hono middleware or by a direct call to `rootSpan(name, attributes?)`. All AI SDK spans within the request are parented under it and share its `traceId`.             |
| Flush                      | The operation that drains the in-memory span buffer and exports all buffered spans to the OTLP endpoint in a single HTTP POST. Registered with `ctx.waitUntil()` to run after the HTTP response is sent.                     |
| Generation                 | A Langfuse observation sub-type representing an LLM call. Carries structured fields for `model`, `modelParameters`, token `usage`, and `cost`. Classified by Langfuse from span name and instrumentation scope.              |
| Instrumentation scope name | The string identifier passed to `provider.getTracer(name)` when obtaining a `Tracer`. Must be `'ai'` for AI SDK spans to trigger Langfuse's AI SDK token-usage extraction path.                                              |
| OTLP/HTTP JSON             | The wire protocol used by this package: OpenTelemetry Protocol over HTTP, with the payload serialized as JSON. The alternative encoding (protobuf) is not used.                                                              |
| `waitUntil`                | A Cloudflare Workers execution context API (`ctx.waitUntil(promise)`) that keeps the isolate alive until `promise` resolves, even after the HTTP response has been sent. Used to extend isolate lifetime for the flush POST. |
| Cold start                 | The first execution of a Worker module in a new isolate instance. Module-level code (including `AsyncLocalStorageContextManager` registration) runs exactly once per cold start.                                             |
| Warm isolate               | A Worker isolate reused across multiple requests in the same instance. Module-level state persists; per-request state must not persist between requests.                                                                     |
