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

`@aotoki/edge-otel` provides a correct OTel SDK for these runtimes.

---

### Users

**Primary: Application developers** deploying Vercel AI SDK workloads to serverless runtimes

| User                            | Context                                                                                                                                    | Need                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Cloudflare Workers developer    | Building AI features with Hono or plain Worker handlers; any OTLP/HTTP collector (e.g., Langfuse, Grafana Tempo, Honeycomb) as the backend | OTel traces from AI SDK calls export to any OTLP/HTTP collector without Node.js SDK dependencies |
| Deno Deploy developer           | Same AI SDK stack; Deno's `node:async_hooks` compat available                                                                              | Same trace export without platform-specific changes                                              |
| Vercel Edge Functions developer | V8 isolate model identical to Cloudflare Workers; same runtime constraints apply                                                           | Same trace export without platform-specific changes                                              |

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

| #   | Feature                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OTLP/HTTP JSON span exporter using only Web Platform APIs (`fetch`, `btoa`) — no Node.js built-ins required                      |
| 2   | OTLP/HTTP + JSON span exporter targeting any compatible collector; Langfuse is a supported backend with a provided preset        |
| 3   | `SimpleSpanProcessor` for per-span buffering with explicit flush via `forceFlush()` — no background timer dependency             |
| 4   | `AsyncLocalStorage`-based context propagation that groups all AI SDK calls within a single request under one trace               |
| 5   | Automatic error tracking: thrown exceptions are recorded as span events and marked `ERROR` status without manual instrumentation |
| 6   | Manual span creation via the standard OTel `Tracer` API for custom instrumentation (RAG retrieval, database queries, etc.)       |

---

### IS / IS NOT

| IS                                                                                                         | IS NOT                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A standard OTel `SpanExporter` implementation on top of `sdk-trace-base`                                   | A full OTel SDK reimplementation from scratch                                                                 |
| Cloudflare Workers as the primary target runtime, portable to Deno Deploy and Vercel Edge by design        | Node.js server support (`@langfuse/otel` + `@opentelemetry/sdk-node` already handles that)                    |
| Any OTLP/HTTP + JSON collector as the export target                                                        | gRPC or protobuf transport support                                                                            |
| `AsyncLocalStorage`-based context propagation for multi-call trace merging (requires `nodejs_compat` flag) | Automatic propagation without the `nodejs_compat` flag                                                        |
| Automatic `ERROR` status when exceptions are thrown by AI SDK calls                                        | Automatic `WARNING` status for soft failures (`finishReason = "error"`) — that remains manual                 |
| Manual spans via the standard OTel `Tracer` API                                                            | Auto-instrumentation of Cloudflare bindings (KV, D1, Durable Objects)                                         |
| Root span lifecycle is the application's responsibility                                                    | Framework-specific middleware (Hono, etc.) — the application creates and manages root spans directly          |
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

|             |                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Context** | A developer has one `generateText` or `streamText` call per Worker request handler and wants it to appear as a trace in the configured collector.                                                                                                                                                                        |
| **Action**  | The developer calls `createTracerProvider` with the collector endpoint and credentials, calls `provider.getTracer('ai')` to obtain a tracer, passes the tracer to `experimental_telemetry.tracer` on the AI SDK call, and registers the flush with `ctx.waitUntil(provider.forceFlush())` before returning the response. |
| **Outcome** | A single trace appears in the configured collector containing the AI SDK span tree (`ai.generateText`, `ai.generateText.doGenerate`) with correct timestamps, token usage, and model attributes.                                                                                                                         |

---

**Journey 2: Multiple AI SDK calls grouped under one trace**

|             |                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer makes multiple sequential `generateText` or `streamText` calls within one request (for example, summarise → translate → format) and wants all calls to appear as one trace rather than separate unrelated traces.                                                                                           |
| **Action**  | The developer enables the `nodejs_compat` compatibility flag, creates a root span via `tracer.startActiveSpan()` to activate it as the request context, then passes the tracer to each AI SDK call within the same request handler, and registers `ctx.waitUntil(provider.forceFlush())` before returning the response. |
| **Outcome** | All AI SDK spans from the request share a single `traceId` and appear as sibling children under the root span in one trace in the collector.                                                                                                                                                                            |

---

**Journey 3: Custom instrumentation alongside AI SDK calls**

|             |                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer wants RAG retrieval steps, database queries, or other application-level operations to appear as spans in the same trace as the AI SDK calls.                                                                     |
| **Action**  | The developer uses the tracer obtained from `provider.getTracer()` to create manual spans via `tracer.startActiveSpan()` for the custom operations, keeping them within the same active request context as the AI SDK calls. |
| **Outcome** | Custom spans appear as siblings alongside the AI SDK spans under the same root trace in the collector, giving a complete end-to-end view of the request.                                                                     |

---

**Journey 4: Automatic error observation**

|             |                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call throws an exception — such as an API authentication error, rate limit response, or network timeout — during request processing.          |
| **Action**  | No manual action is required; the AI SDK records the exception on the span and sets the span status to ERROR before re-throwing.                        |
| **Outcome** | The span is marked ERROR with the exception type, message, and stack trace recorded as a span event; the error observation is visible in the collector. |

---

**Journey 5: Soft error warning (manual)**

|             |                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | An AI SDK call returns successfully (no exception thrown) but `finishReason` is `"error"` or `"content-filter"`, indicating the generation was not completed as expected.                                  |
| **Action**  | After the AI SDK call returns, the developer inspects `finishReason` and sets the span status or backend-specific attributes to signal the soft failure.                                                   |
| **Outcome** | The span status reflects the soft failure and the observation is visible in the collector. Backend-specific signaling (e.g., `langfuse.observation.level`) is documented in the backend integration guide. |

---

**Journey 6: Swapping the export backend**

|             |                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer wants to send traces to a different OTLP-compatible collector — such as Grafana Tempo, Jaeger, Honeycomb, or a self-hosted OpenTelemetry Collector — instead of Langfuse. |
| **Action**  | The developer changes the URL and authorization credentials in the `createTracerProvider` configuration; no other code changes are required.                                          |
| **Outcome** | The same AI SDK spans are exported to the alternative collector using OTLP/HTTP JSON; the AI SDK integration layer and context propagation are unaffected.                            |

---

**Journey 7: Multi-call trace grouping without `nodejs_compat`**

|             |                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context** | A developer cannot enable the `nodejs_compat` flag (due to policy or binary size constraints) but still wants multiple AI SDK calls within one request to share a single trace.                     |
| **Action**  | The developer creates a root span manually and wraps each AI SDK call individually in an explicit `context.with()` call that sets the root span as the active context immediately before each call. |
| **Outcome** | All AI SDK calls inherit the root span's `traceId` via manual context threading and appear as children under the same trace in the collector, without requiring `AsyncLocalStorage`.                |

---

## Behavior

The Behavior section defines the observable contracts for each major component. Full behavioral rules, tables, and error scenarios are in the detail documents linked below.

### OTLP Span Exporter

Accumulates spans in-memory during a request and exports them to an OTLP/HTTP JSON endpoint in a single flush after the HTTP response is sent using only Web Platform APIs. Covers exporter operations, wire format encoding rules, authentication, constraints, and error scenarios.

See [OTLP Span Exporter](docs/behavior/exporter.md)

---

### Tracer Provider Factory

Accepts configuration, wires `SimpleSpanProcessor` + `OtlpHttpJsonExporter` + `BasicTracerProvider` together, and returns a `TracerProvider` with `getTracer(scopeName)` and `forceFlush()`. Named `createTracerProvider` following standard OTel convention — the application obtains a tracer via `provider.getTracer(scopeName)`. Never registers the provider as a global OTel singleton. Covers the provider contract, global registration avoidance, instrumentation scope name, resource attributes, context manager registration, root span creation via standard OTel API, configuration, and error scenarios.

See [Tracer Provider Factory](docs/behavior/provider.md)

---

### Context Propagation

Defines how AI SDK calls within one request are grouped under a single trace. Covers the `AsyncLocalStorage` pattern (requires `nodejs_compat`), the manual `context.with()` pattern (no flag required), tool call context propagation requirements and the known failure mode when `nodejs_compat` is absent, and the pattern selection decision matrix.

See [Context Propagation](docs/behavior/context.md)

---

### Error Handling

Classifies errors into hard (thrown), soft (non-thrown finish reason), and export categories. Covers automatic exception recording by the AI SDK, AI SDK error types, retry visibility, the soft error gap, OTel status code values, and export error isolation.

See [Error Handling](docs/behavior/error-handling.md)

---

## Refinement

The Refinement section defines the public API surface, TypeScript interfaces, OTLP wire format types, terminology, the implementation correctness checklist, and extensibility and portability rules.

See [Contracts, Types & Extensibility](docs/contracts.md)

### Architecture

Defines the layer structure adapted for library design (Entities → Use Cases → Interface Adapters → Frameworks & Drivers), the directory-to-layer mapping, the two entry points (Core, Langfuse Preset), and the dependency direction rules that enforce inward-only imports.

See [Architecture Overview](docs/architecture.md)

---

## Backend-Specific Guidance

The core specification above is backend-agnostic. Backend presets provide default configuration values and may require additional HTTP headers or span attributes.

### Langfuse

Documents the Langfuse exporter configuration (endpoint, required header, authentication, `environment` and `release` options that map to OTel resource attributes), the semantic mapping rules (data model, generation detection, token usage attribute keys, model name resolution, trace metadata attributes, environment/release, model parameters, observation level and error mapping, soft error WARNING attribute, trace-level error propagation, AI SDK tool call span hierarchy and observation type, context propagation requirement for tool calls and the known failure mode when `nodejs_compat` is absent, resulting trace structure), and the behavioral correctness rules.

See [Langfuse Backend Guidance](docs/backends/langfuse.md)
