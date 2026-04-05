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

| Package                              | Role                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opentelemetry/api`                 | Core OTel interfaces: `Tracer`, `Span`, `SpanKind`, `SpanStatusCode`, `context`, `trace`                                                                              |
| `@opentelemetry/sdk-trace-base`      | Runtime-agnostic tracing primitives: `BasicTracerProvider`, `SimpleSpanProcessor`, `ReadableSpan`, `SpanExporter`                                                     |
| `@opentelemetry/resources`           | `Resource` descriptor carrying `service.name` and `telemetry.sdk.*` attributes                                                                                        |
| `@opentelemetry/context-async-hooks` | `AsyncLocalStorageContextManager` for context propagation across `await` boundaries — requires `nodejs_compat` flag; optional for single-call-per-request deployments |

<!-- Behavior and Refinement sections to follow -->
