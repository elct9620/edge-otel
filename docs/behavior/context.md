# Context Propagation

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

Context propagation is how all AI SDK calls within one request are grouped under a single trace rather than appearing as separate unrelated traces. This section defines both available propagation patterns and when each applies. See User Journeys 2 and 7 in the main specification for the corresponding end-to-end flows.

---

## How Context Inheritance Works

OpenTelemetry carries trace identity in a `Context` object. When an AI SDK call starts a new span, it reads the currently active context via `context.active()` to determine its parent. If the active context holds a live span, the new span inherits that span's `traceId` and records the parent's `spanId` as its `parentSpanId`. If no span is active, the AI SDK call starts a fresh root span with a new, unrelated `traceId`.

| Active context at call time | Result                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No active span              | AI SDK call becomes a new root span with its own `traceId` — appears as a separate, unrelated trace in the backend |
| Active span present         | AI SDK call inherits the active span's `traceId` and becomes a child — appears under the same trace                |

The `experimental_telemetry.tracer` option controls which provider records the span, but has no effect on parentage. Parentage is determined solely by the active context at the moment the span is started.

---

## Propagation with `AsyncLocalStorage` (requires `nodejs_compat`)

_Corresponds to User Journey 2._

When `AsyncLocalStorageContextManager` is registered on the first `createTracerProvider()` call (see Provider Factory — Context Manager Registration), the OTel context flows automatically across all `await` boundaries within a request.

| Step                                | Observable behavior                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First `createTracerProvider()` call | `AsyncLocalStorageContextManager` is enabled once via a once-guard. All subsequent spans on any async execution path can read the active context automatically. |
| Root span creation                  | The developer calls `tracer.startActiveSpan(name, fn)` to create a root span and activate it as the current context for the duration of `fn`.                   |
| Context activation                  | For the duration of `fn`, the root span is the active context on that async execution path. No manual `context.with()` call is needed.                          |
| AI SDK calls inside handler         | Each call reads `context.active()`, finds the root span, and becomes a child. No per-call wrapping is needed.                                                   |
| Manual spans inside handler         | `tracer.startActiveSpan()` calls also inherit the root span as parent without any extra configuration.                                                          |
| Parallel calls via `Promise.all`    | All parallel branches spawned inside the `startActiveSpan` callback inherit the root span's context automatically.                                              |

This pattern requires the `nodejs_compat` compatibility flag in `wrangler.toml`. Without it, the module-level import of `@opentelemetry/context-async-hooks` fails and the Worker does not start.

---

## Manual Context Threading (without `nodejs_compat`)

_Corresponds to User Journey 7._

When `AsyncLocalStorage` is unavailable, context does not propagate automatically across `await` boundaries. Each AI SDK call must be individually wrapped to receive the parent context.

| Step                             | Observable behavior                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root span creation               | The developer creates a root span and holds a reference to it and the associated context.                                                                                                                                                                |
| Per-call wrapping                | Each AI SDK call is wrapped in `context.with(ctx, () => call(...))` where `ctx` is a context derived from the root span. The AI SDK reads `context.active()` synchronously at span-start time, finds the root span, and records the parent relationship. |
| Sequential calls                 | Each call is wrapped individually. Calls execute one after the other; each receives the same root context.                                                                                                                                               |
| Parallel calls via `Promise.all` | Each parallel call is wrapped in its own `context.with(ctx, ...)`. Without per-branch wrapping, parallel branches do not inherit the root span and each starts a new trace.                                                                              |
| Calls without wrapping           | Any AI SDK call not wrapped in `context.with(ctx, ...)` starts a new root span with an independent `traceId` and appears as a separate, unrelated trace in the backend.                                                                                  |

This pattern requires no additional dependencies or compatibility flags. It is more verbose than the `AsyncLocalStorage` pattern but produces identical trace output.

---

## Tool Call Context Propagation

When `generateText` or `streamText` uses tools, the Vercel AI SDK invokes each tool function as part of the same async execution chain. The AI SDK emits an `ai.toolCall` span for each tool invocation. The parent of that span is determined by the OTel context active at the moment the tool function is called — not at the moment the outer `generateText` call was made.

| Condition                                                          | Result                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AsyncLocalStorageContextManager` active                           | OTel context flows automatically into the tool function across `await` boundaries. The `ai.toolCall` span inherits the correct parent without any additional wrapping.                     |
| `AsyncLocalStorageContextManager` not active (`nodejs_compat` off) | OTel context does not flow into the tool function. The `ai.toolCall` span starts without a parent and receives a new independent `traceId`. It appears as a separate trace in the backend. |

`ai.toolCall` spans are **siblings** of `ai.generateText.doGenerate` in the span hierarchy — both are direct children of the top-level `ai.generateText` span. This parentage is established automatically by the AI SDK as long as the context is correctly propagated.

Because tool functions are invoked by the AI SDK internally, there is no user-controlled wrapping point where `context.with()` can be applied. The `AsyncLocalStorage`-based propagation pattern is the only mechanism that correctly parents tool call spans without SDK-level changes. For deployments where `nodejs_compat` is unavailable, tool call spans will not be correctly parented and will appear as detached root-level traces.

---

## Pattern Selection

| Scenario                                                          | Pattern                                                                                                                                                                        | `nodejs_compat` required |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Single AI SDK call per request                                    | Pass `tracer` directly; no propagation needed                                                                                                                                  | No                       |
| Multiple sequential calls, grouped under one trace                | `AsyncLocalStorage` + `tracer.startActiveSpan()` root span (via middleware or manually)                                                                                        | Yes                      |
| Multiple sequential calls, `nodejs_compat` unavailable            | Manual `context.with()` per call                                                                                                                                               | No                       |
| Parallel calls via `Promise.all`, with `nodejs_compat` enabled    | All parallel branches spawned inside the outer `startActiveSpan` callback inherit context automatically; no per-branch wrapping needed                                         | Yes                      |
| Parallel calls via `Promise.all`, without `nodejs_compat` enabled | Each parallel call must be individually wrapped in `context.with(ctx, ...)` — without per-branch wrapping each branch starts an independent new trace                          | No                       |
| AI SDK tool calls (`generateText` with tools)                     | Requires `AsyncLocalStorage`; tool functions execute inside the AI SDK and cannot be manually wrapped. Without `nodejs_compat`, tool call spans appear as detached root traces | Yes                      |
