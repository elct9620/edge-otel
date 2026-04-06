# Contracts, Types & Extensibility

> Part of [@aotoki/edge-otel specification](../SPEC.md)

This document defines the public API surface, the TypeScript interfaces that implement that surface, the wire format types that the serializer and any future implementer must produce identically, the key terms used throughout this specification, the implementation correctness checklist, and the extensibility and portability rules.

---

## Contracts & Types

### Public API Surface

The package exposes exactly the following identifiers at its public boundary. Internal types, helper functions, and the span processor wiring are not part of the public API.

| Export                  | Kind      | Purpose                                                                                                                      |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `createTracerProvider`  | Function  | Factory: accepts configuration and returns a `TracerHandle`                                                                  |
| `TracerHandle`          | Interface | The object returned by the factory; consumed by application code                                                             |
| `TracerProviderOptions` | Interface | Configuration accepted by the factory; extends the exporter config with `serviceName`, `scopeName`, and `resourceAttributes` |
| `ExporterConfig`        | Interface | Endpoint and headers configuration for the OTLP/HTTP exporter                                                                |
| `OtlpHttpJsonExporter`  | Class     | The OTLP/HTTP JSON exporter; exported for advanced use (custom processor wiring, multiple backends)                          |
| `createHonoMiddleware`  | Function  | Returns a Hono middleware function that manages root span lifecycle for a complete Hono request                              |

`OtlpHttpJsonExporter` is exported because implementers wiring multiple backends or a custom `SimpleSpanProcessor` need direct access to the exporter instance. It is not required for typical single-backend use.

Backend presets (e.g., a Langfuse preset) may provide convenience wrappers that construct `ExporterConfig` from backend-specific credentials and supply default endpoint URLs and required HTTP headers. These presets are not part of the core public API surface.

---

### Configuration Contract

`ExporterConfig` captures the endpoint and headers needed to POST spans to any OTLP/HTTP JSON endpoint.

| Field      | Type                     | Required | Default | Description                                                                                            |
| ---------- | ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `endpoint` | `string`                 | Yes      | —       | Full URL of the OTLP/HTTP JSON traces endpoint (e.g. `https://example.com/api/public/otel/v1/traces`). |
| `headers`  | `Record<string, string>` | No       | `{}`    | Additional HTTP headers sent with every export POST (authentication, backend-specific headers, etc.).  |

`TracerProviderOptions` extends `ExporterConfig` with additional fields.

| Field                | Type                     | Required | Default               | Description                                                                                                           |
| -------------------- | ------------------------ | -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `serviceName`        | `string`                 | No       | `'cloudflare-worker'` | Value of the `service.name` OTel resource attribute attached to all spans.                                            |
| `scopeName`          | `string`                 | No       | `'ai'`                | Instrumentation scope name passed to `provider.getTracer()`. Default matches AI SDK convention.                       |
| `resourceAttributes` | `Record<string, string>` | No       | `{}`                  | Additional OTel resource attributes merged into the resource. Used for backend metadata (e.g., environment, release). |

TypeScript interface:

```typescript
interface ExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

interface TracerProviderOptions extends ExporterConfig {
  serviceName?: string;
  scopeName?: string;
  resourceAttributes?: Record<string, string>;
}
```

---

### Handle Contract

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

### OTLP JSON Wire Format Types

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

| Field               | Encoding rule                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `traceId`           | Lowercase hex string, exactly 32 characters                                                                              |
| `spanId`            | Lowercase hex string, exactly 16 characters                                                                              |
| `parentSpanId`      | Omitted entirely for root spans — an empty string is incorrect and causes backend rejection                              |
| `startTimeUnixNano` | Built by string concatenation: `"${seconds}${nanos.padStart(9, '0')}"` — arithmetic overflows `MAX_SAFE_INTEGER`         |
| `endTimeUnixNano`   | Same rule as `startTimeUnixNano`                                                                                         |
| `intValue`          | Decimal string — token counts and other 64-bit counters may exceed `Number.MAX_SAFE_INTEGER`                             |
| `scope.name`        | Must be exactly `'ai'` for AI SDK spans — the AI SDK convention; some backends gate token-usage extraction on this value |

---

### Terminology

| Term                       | Definition                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handle                     | The object returned by `createTracerProvider`; contains `tracer`, `flush`, and `rootSpan`. The application holds this object and uses it for every AI SDK call and flush registration within a request.                                                                 |
| Root span                  | The top-level span for a single request; created by the Hono middleware or by a direct call to `rootSpan(name, attributes?)`. All AI SDK spans within the request are parented under it and share its `traceId`.                                                        |
| Flush (`flush`)            | The Handle method that drains the in-memory span buffer and exports all buffered spans to the OTLP endpoint in a single HTTP POST. Internally delegates to the exporter's `forceFlush()`. Registered with `ctx.waitUntil()` to run after the HTTP response is sent.     |
| `forceFlush()`             | The exporter-level method that performs the actual buffer drain, serialization, and HTTP POST. Called by the Handle's `flush` method. Also called by `shutdown()` to drain remaining spans before the exporter is closed.                                               |
| Generation                 | An OTel span representing an LLM call, carrying model, token usage, and cost attributes. Backend-specific (e.g., Langfuse classifies this as a distinct observation sub-type).                                                                                          |
| Instrumentation scope name | The string identifier passed to `provider.getTracer(name)` when obtaining a `Tracer`. Must be `'ai'` for AI SDK spans — the convention established by the Vercel AI SDK.                                                                                                |
| OTLP/HTTP JSON             | The wire protocol used by this package: OpenTelemetry Protocol over HTTP, with the payload serialized as JSON. The alternative encoding (protobuf) is not used.                                                                                                         |
| `waitUntil`                | A Cloudflare Workers execution context API (`ctx.waitUntil(promise)`) that keeps the isolate alive until `promise` resolves, even after the HTTP response has been sent. Used to extend isolate lifetime for the flush POST.                                            |
| Cold start                 | The first execution of a Worker module in a new isolate instance. Module-level code (including `AsyncLocalStorageContextManager` registration) runs exactly once per cold start.                                                                                        |
| Warm isolate               | A Worker isolate reused across multiple requests in the same instance. Module-level state persists; per-request state must not persist between requests.                                                                                                                |
| Backend preset             | A configuration helper that constructs an `ExporterConfig` with the default `endpoint` URL and required `headers` for a specific backend. Adding a new preset requires no changes to the core exporter, processor, or provider. Langfuse is the first supported preset. |

---

## Implementation Checklist

This checklist captures correctness rules where a violation produces silent bad data or silent span loss rather than a visible error. All rules are observable behavioral contracts — they describe what must be true of the system's output, not how to produce it.

### Generic OTLP Correctness Rules

| #   | Rule                                                                                                                                                                                 | Consequence of violation                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `startTimeUnixNano` and `endTimeUnixNano` are decimal strings produced by string concatenation of seconds and zero-padded nanoseconds — not by arithmetic multiplication             | Arithmetic overflow past `Number.MAX_SAFE_INTEGER` silently rounds the value; all span timestamps in the collector are wrong by an arbitrary amount, with no error thrown           |
| 2   | `intValue` attribute values are decimal strings, not JavaScript numbers                                                                                                              | Token counts and 64-bit counters that exceed `Number.MAX_SAFE_INTEGER` are silently rounded by `JSON.stringify`; structured usage fields in the collector contain incorrect values  |
| 3   | `parentSpanId` is omitted entirely from the JSON object when a span has no parent — an empty string `""` is not a valid substitute                                                   | Backends treat an empty `parentSpanId` as a malformed or non-root span; Langfuse rejects the span or misparses the trace hierarchy                                                  |
| 4   | The tracer provider is never registered as the global OTel singleton — the `tracer` reference from the handle is the only path by which spans enter the provider                     | Global registration pollutes the shared OTel singleton; in warm isolates, multiple requests may write to the same global state, causing trace cross-contamination                   |
| 5   | `AsyncLocalStorageContextManager` is active before the first request handler fires — it is registered at module initialisation time, not inside a request handler or middleware body | Context propagation falls back to the noop manager for any span created before registration; AI SDK calls made in module-level code produce orphaned spans with no parent           |
| 6   | `flush()` always resolves — it never rejects, regardless of HTTP export errors                                                                                                       | A rejected `flush()` propagates through `ctx.waitUntil()` and leaves the isolate in an undefined termination state; subsequent spans in the same isolate may be silently dropped    |
| 7   | `SimpleSpanProcessor` is the span processor in use — `BatchSpanProcessor` is not used                                                                                                | `BatchSpanProcessor` depends on background timers that do not survive isolate request boundaries; spans buffered in its internal queue are silently dropped when the isolate exits  |
| 8   | `ctx.waitUntil(flush())` is called before the HTTP response is returned                                                                                                              | Once the response is returned without a `waitUntil` registration, the isolate may be torn down before the export `fetch()` completes; all buffered spans are silently dropped       |
| 9   | For `streamText`, the flush is deferred until the response stream is fully consumed                                                                                                  | `ai.streamText.doStream` spans end only when the stream is consumed; flushing before consumption exports an incomplete span — missing end time, output tokens, and usage attributes |
| 10  | `forceFlush()` is called to drain spans per request — `shutdown()` is not used for per-request flushing                                                                              | `shutdown()` permanently marks the exporter as shut down; subsequent `export()` calls are rejected, silently dropping all spans for the remainder of the isolate's lifetime         |

Additional correctness rules specific to Langfuse are documented in [Backend-Specific Guidance § Langfuse § Semantic Mapping](backends/langfuse.md#semantic-mapping).

---

## Extensibility & Portability

### Backend Swappability

The exporter targets any OTLP/HTTP + JSON endpoint. The endpoint URL and all HTTP headers (including authentication) are runtime configuration — no recompilation is required to change backends.

Multiple exporters can be wired to the same provider by attaching a separate `SimpleSpanProcessor` for each exporter. Every span processor in the chain receives each span; spans are forwarded to all attached exporters independently.

| Capability                     | Description                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Any OTLP/HTTP + JSON endpoint  | Supply the endpoint URL and any required headers in `ExporterConfig`; the exporter sends spans there |
| Multiple simultaneous backends | Add one `SimpleSpanProcessor` per exporter to the provider; all processors receive every span        |
| Backend preset                 | Provides default `endpoint` and `headers` values for a specific backend; no other component changes  |

Adding support for a new backend requires only a new preset that constructs an `ExporterConfig` — the exporter, processor, provider, and middleware are unchanged. Langfuse is the first supported backend preset.

---

### Custom Span Support

The `tracer` member of `TracerHandle` is a standard OTel `Tracer` from `@opentelemetry/api`. Application code uses it to create manual spans for any operation that should appear in the trace — RAG retrieval, database queries, external API calls, or any other unit of work.

Manual spans created via the tracer automatically join the active trace when a root context is in scope. No extra configuration is required; context inheritance follows the same rules as AI SDK spans (see [Context Propagation](behavior/context.md)).

---

### Runtime Portability

The package depends only on Web Platform APIs (`fetch()`, `btoa()`, `crypto.getRandomValues()`) and the four OTel packages listed under Dependencies. These are available across all major serverless runtimes.

The only runtime-specific integration point is how the host keeps the process alive after the HTTP response is sent — the `waitUntil()` spelling varies by platform.

| Runtime               | ALS available                           | Flush mechanism                          | Notes          |
| --------------------- | --------------------------------------- | ---------------------------------------- | -------------- |
| Cloudflare Workers    | `nodejs_compat` flag                    | `ctx.waitUntil(flush())`                 | Primary target |
| Deno Deploy           | `node:async_hooks` compatibility module | `Deno.serve` handler `waitUntil`         |                |
| Vercel Edge Functions | V8 isolate — same model as CF           | `event.waitUntil(flush())`               |                |
| AWS Lambda@Edge       | Node.js runtime — no flags              | `context.callbackWaitsForEmptyEventLoop` |                |

---

### Known Limitations

| Item                    | Status        | Note                                                                                                                        |
| ----------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Protobuf serialization  | Not supported | Would reduce payload size ~30–50%; blocked on a viable pure-JS encoder within acceptable bundle size                        |
| Batch span processing   | Not supported | `BatchSpanProcessor` is incompatible with short-lived isolates; `SimpleSpanProcessor` with explicit flush is used instead   |
| Streaming TTFT tracking | Not supported | Time-to-first-token from `streamText` calls is not yet captured as a span attribute                                         |
| Cost tracking           | Not supported | Per-model cost derived from token counts is not computed; backends that support it (e.g., Langfuse) derive cost server-side |
