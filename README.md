# @aotoki/edge-otel

[![Tests](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml/badge.svg)](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/elct9620/edge-otel/graph/badge.svg)](https://codecov.io/gh/elct9620/edge-otel)

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
import { langfuseExporter } from "@aotoki/edge-otel/exporters/langfuse";
import { Hono } from "hono";

type Env = {
  Bindings: {
    LANGFUSE_PUBLIC_KEY: string;
    LANGFUSE_SECRET_KEY: string;
  };
};

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  const provider = createTracerProvider({
    ...langfuseExporter({
      publicKey: c.env.LANGFUSE_PUBLIC_KEY,
      secretKey: c.env.LANGFUSE_SECRET_KEY,
    }),
    serviceName: "my-worker",
  });

  const middleware = createHonoMiddleware(provider);
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

const provider = createTracerProvider({
  endpoint: "https://your-collector.example.com/v1/traces",
  headers: {
    Authorization: "Bearer your-token",
  },
});

const tracer = provider.getTracer("ai");

// Use tracer with AI SDK
const result = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hello!",
  experimental_telemetry: {
    isEnabled: true,
    tracer,
  },
});

// Flush spans before the isolate exits
ctx.waitUntil(provider.forceFlush());
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

### Streaming with `deferFlush`

When using `streamText`, spans are not complete until the stream is fully consumed. Use `deferFlush` to delay the flush:

```typescript
app.post("/chat", async (c) => {
  const tracer = c.get("tracer");
  const deferFlush = c.get("deferFlush");

  const result = streamText({
    model: openai("gpt-4o"),
    prompt: "Hello!",
    experimental_telemetry: { isEnabled: true, tracer },
  });

  // Defer flush until the stream is fully consumed
  deferFlush(result.textStream);

  return c.body(result.textStream);
});
```

## API

### `createTracerProvider(options): TracerProvider`

Creates a tracer provider wired with `SimpleSpanProcessor` and `OtlpHttpJsonExporter`.

**Options:**

| Option               | Type                     | Default               | Description                                |
| -------------------- | ------------------------ | --------------------- | ------------------------------------------ |
| `endpoint`           | `string`                 | _(required)_          | Full OTLP/HTTP endpoint URL                |
| `headers`            | `Record<string, string>` | `{}`                  | Custom HTTP headers for the export request |
| `serviceName`        | `string`                 | `'cloudflare-worker'` | `service.name` resource attribute          |
| `resourceAttributes` | `Record<string, string>` | `{}`                  | Additional OTel resource attributes        |

**Returns `TracerProvider`:**

| Member                 | Type                            | Description                                                 |
| ---------------------- | ------------------------------- | ----------------------------------------------------------- |
| `getTracer(scopeName)` | `(scopeName: string) => Tracer` | Pass the returned tracer to `experimental_telemetry.tracer` |
| `forceFlush()`         | `() => Promise<void>`           | Register with `ctx.waitUntil(provider.forceFlush())`        |

### `createHonoMiddleware(provider, options?): MiddlewareHandler`

Hono middleware that manages root span lifecycle per request. Receives a `TracerProvider` and calls `provider.getTracer()` and `provider.forceFlush()` internally.

```typescript
import { createHonoMiddleware } from "@aotoki/edge-otel/middleware/hono";
```

**Options:**

| Option       | Type                     | Default          | Description                               |
| ------------ | ------------------------ | ---------------- | ----------------------------------------- |
| `spanName`   | `string`                 | `'http.request'` | Root span name                            |
| `scopeName`  | `string`                 | `'ai'`           | Instrumentation scope name for the tracer |
| `attributes` | `Record<string, string>` | `undefined`      | Additional root span attributes           |

The middleware:

- Creates a root span via `tracer.startActiveSpan()` and activates context propagation
- Exposes `tracer` via `c.get('tracer')` for handler code
- Exposes `deferFlush` via `c.get('deferFlush')` for streaming — call `deferFlush(streamPromise)` to delay the flush until the stream completes
- Records exceptions and sets ERROR status on failures
- Ends the span and flushes via `c.executionCtx.waitUntil()` in all paths

### `langfuseExporter(options): LangfuseExporterConfig`

Constructs a `LangfuseExporterConfig` (extends `ExporterConfig` with optional `resourceAttributes`) for Langfuse. Spread the result into `createTracerProvider`.

```typescript
import { langfuseExporter } from "@aotoki/edge-otel/exporters/langfuse";
```

**Options:**

| Option        | Type     | Default                        | Description                                      |
| ------------- | -------- | ------------------------------ | ------------------------------------------------ |
| `publicKey`   | `string` | _(required)_                   | Langfuse public key (`pk-lf-...`)                |
| `secretKey`   | `string` | _(required)_                   | Langfuse secret key (`sk-lf-...`)                |
| `baseUrl`     | `string` | `'https://cloud.langfuse.com'` | Langfuse instance URL                            |
| `environment` | `string` | `undefined`                    | Deployment environment (e.g., `"production"`)    |
| `release`     | `string` | `undefined`                    | Application release identifier (e.g., `"1.0.0"`) |

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
- **`forceFlush()` always resolves** — Export failures are logged via `console.warn`, never reject (safe for `waitUntil`)
- **No global registration** — Provider is never registered as a global OTel singleton; tracer is passed directly via `provider.getTracer()`
- **Timestamps as nanosecond strings** — Built via string concatenation to avoid `Number.MAX_SAFE_INTEGER` overflow

## License

Apache-2.0
