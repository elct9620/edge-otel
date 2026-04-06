# @aotoki/edge-otel

Lightweight OpenTelemetry SDK for V8 isolate edge runtimes (Cloudflare Workers, Vercel Edge Functions, Deno Deploy).

Uses only Web Platform APIs (`fetch`, `btoa`) — no Node.js built-ins required.

## Why

The standard `@opentelemetry/sdk-node` depends on `node:perf_hooks`, `node:async_hooks`, and `node:http`, which are absent or broken in V8 isolate runtimes. This package provides a correct OTel span exporter and tracer provider that works in these environments.

## Install

```bash
pnpm add @aotoki/edge-otel
```

Peer dependency for Hono middleware (optional):

```bash
pnpm add hono
```

## Quick Start

### Cloudflare Workers with Hono

```typescript
import { createTracerProvider } from "@aotoki/edge-otel";
import { createHonoMiddleware } from "@aotoki/edge-otel/middleware/hono";
import { langfusePreset } from "@aotoki/edge-otel/exporters/langfuse";
import { Hono } from "hono";

const app = new Hono();

app.use("*", async (c, next) => {
  const handle = createTracerProvider(
    langfusePreset({
      publicKey: c.env.LANGFUSE_PUBLIC_KEY,
      secretKey: c.env.LANGFUSE_SECRET_KEY,
    }),
  );
  const middleware = createHonoMiddleware(handle);
  return middleware(c, next);
});

app.get("/", async (c) => {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt: "Hello!",
    experimental_telemetry: {
      isEnabled: true,
      tracer: c.get("tracer"),
    },
  });
  return c.json({ text: result.text });
});

export default app;
```

### Any OTLP/HTTP Collector

```typescript
import { createTracerProvider } from "@aotoki/edge-otel";

const handle = createTracerProvider({
  endpoint: "https://your-collector.example.com/v1/traces",
  headers: {
    Authorization: "Bearer your-token",
  },
});

// Use handle.tracer with AI SDK
const result = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hello!",
  experimental_telemetry: {
    isEnabled: true,
    tracer: handle.tracer,
  },
});

// Flush spans before the isolate exits
ctx.waitUntil(handle.flush());
```

### Manual Spans

```typescript
app.get("/rag", async (c) => {
  const tracer = c.get("tracer");

  // Custom spans appear alongside AI SDK spans in the same trace
  const docs = await tracer.startActiveSpan("rag.retrieve", async (span) => {
    try {
      const results = await vectorStore.similaritySearch(query, 5);
      span.setAttribute("rag.result_count", results.length);
      return results;
    } finally {
      span.end();
    }
  });

  const result = await generateText({
    model: openai("gpt-4o"),
    prompt: buildPrompt(docs),
    experimental_telemetry: { isEnabled: true, tracer },
  });

  return c.json({ text: result.text });
});
```

## API

### `createTracerProvider(options): TracerHandle`

Creates a tracer provider wired with `SimpleSpanProcessor` and `OtlpHttpJsonExporter`.

**Options:**

| Option        | Type                     | Default               | Description                                |
| ------------- | ------------------------ | --------------------- | ------------------------------------------ |
| `endpoint`    | `string`                 | _(required)_          | Full OTLP/HTTP endpoint URL                |
| `headers`     | `Record<string, string>` | `{}`                  | Custom HTTP headers for the export request |
| `serviceName` | `string`                 | `'cloudflare-worker'` | `service.name` resource attribute          |
| `scopeName`   | `string`                 | `'ai'`                | Instrumentation scope name                 |

**Returns `TracerHandle`:**

| Property                      | Type                              | Description                                   |
| ----------------------------- | --------------------------------- | --------------------------------------------- |
| `tracer`                      | `Tracer`                          | Pass to `experimental_telemetry.tracer`       |
| `flush()`                     | `() => Promise<void>`             | Register with `ctx.waitUntil(handle.flush())` |
| `rootSpan(name, attributes?)` | `(name, attrs?) => { span, ctx }` | Create a root span with activated context     |

### `createHonoMiddleware(handle, options?): MiddlewareHandler`

Hono middleware that manages root span lifecycle per request.

```typescript
import { createHonoMiddleware } from "@aotoki/edge-otel/middleware/hono";
```

**Options:**

| Option       | Type                     | Default          | Description                     |
| ------------ | ------------------------ | ---------------- | ------------------------------- |
| `spanName`   | `string`                 | `'http.request'` | Root span name                  |
| `attributes` | `Record<string, string>` | `undefined`      | Additional root span attributes |

The middleware:

- Creates a root span and activates context propagation
- Exposes `tracer` via `c.get('tracer')`
- Records exceptions and sets ERROR status on failures
- Ends the span and flushes via `c.executionCtx.waitUntil()` in all paths

### `langfusePreset(options): ExporterConfig`

Constructs an `ExporterConfig` for Langfuse.

```typescript
import { langfusePreset } from "@aotoki/edge-otel/exporters/langfuse";
```

**Options:**

| Option      | Type     | Default                        | Description                       |
| ----------- | -------- | ------------------------------ | --------------------------------- |
| `publicKey` | `string` | _(required)_                   | Langfuse public key (`pk-lf-...`) |
| `secretKey` | `string` | _(required)_                   | Langfuse secret key (`sk-lf-...`) |
| `baseUrl`   | `string` | `'https://cloud.langfuse.com'` | Langfuse instance URL             |

### `OtlpHttpJsonExporter`

Exported for advanced use cases (e.g., multiple backends, custom span processors).

```typescript
import { OtlpHttpJsonExporter } from "@aotoki/edge-otel";
```

## Requirements

- **Cloudflare Workers**: `nodejs_compat` compatibility flag required for multi-call trace grouping via `AsyncLocalStorage`
- **Single AI SDK call per request**: No compatibility flag needed
- **Hono**: `>= 4.0.0` (optional peer dependency)

## Key Design Decisions

- **`SimpleSpanProcessor` only** — `BatchSpanProcessor` relies on background timers that don't survive V8 isolate lifecycle
- **`flush()` always resolves** — Export failures are logged via `console.warn`, never reject (safe for `waitUntil`)
- **No global registration** — Provider is never registered as a global OTel singleton; tracer is passed directly via handle
- **Timestamps as nanosecond strings** — Built via string concatenation to avoid `Number.MAX_SAFE_INTEGER` overflow

## License

Apache-2.0
