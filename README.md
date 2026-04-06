# @aotoki/edge-otel

[![Tests](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml/badge.svg)](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/elct9620/edge-otel/graph/badge.svg)](https://codecov.io/gh/elct9620/edge-otel)

Lightweight OpenTelemetry SDK for V8 isolate edge runtimes (Cloudflare Workers, Vercel Edge Functions, Deno Deploy).

The standard `@opentelemetry/sdk-node` depends on `node:perf_hooks`, `node:async_hooks`, and `node:http`, which are absent or broken in V8 isolate runtimes. This package provides a correct OTel span exporter and tracer provider that works in these environments using only Web Platform APIs (`fetch`, `btoa`) — no Node.js built-ins required.

## Features

- **OTLP/HTTP JSON exporter** — exports spans to any OTLP-compatible collector (Langfuse, Grafana Tempo, Honeycomb, Jaeger, etc.)
- **SimpleSpanProcessor** — per-span buffering with explicit flush, no background timers
- **Context propagation** — `AsyncLocalStorage`-based trace grouping across multiple AI SDK calls
- **Hono middleware** — root span lifecycle, error capture, and flush registration out of the box
- **Langfuse preset** — pre-configured exporter for Langfuse backend
- **Manual spans** — standard OTel `Tracer` API for custom instrumentation (RAG, DB queries, etc.)
- **Streaming support** — `deferFlush` delays export until the stream is fully consumed

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

Creates a tracer provider wired with `SimpleSpanProcessor` and `OtlpHttpJsonExporter`. Options include `endpoint`, `headers`, `serviceName`, and `resourceAttributes`. Returns a provider with `getTracer(scopeName)` and `forceFlush()`.

```typescript
import { createTracerProvider } from "@aotoki/edge-otel";
```

### `createHonoMiddleware(provider, options?): MiddlewareHandler`

Hono middleware that manages root span lifecycle per request. Creates a root span, exposes `tracer` and `deferFlush` via Hono context, captures errors, and flushes via `c.executionCtx.waitUntil()`.

```typescript
import { createHonoMiddleware } from "@aotoki/edge-otel/middleware/hono";
```

### `langfuseExporter(options): LangfuseExporterConfig`

Constructs exporter configuration for Langfuse. Spread the result into `createTracerProvider`. Accepts `publicKey`, `secretKey`, and optional `baseUrl`, `environment`, `release`.

```typescript
import { langfuseExporter } from "@aotoki/edge-otel/exporters/langfuse";
```

### `OtlpHttpJsonExporter`

Exported for advanced use cases (e.g., multiple backends, custom span processors).

```typescript
import { OtlpHttpJsonExporter } from "@aotoki/edge-otel";
```

## Requirements

- **Cloudflare Workers**: `nodejs_compat` compatibility flag required for multi-call trace grouping via `AsyncLocalStorage`
- **Single AI SDK call per request**: No compatibility flag needed
- **Hono**: `>= 4.0.0` (optional peer dependency)

## Documentation

For detailed specifications and design rationale:

- [Specification Overview](SPEC.md) — project scope, user journeys, and feature list
- [API Contracts & Types](docs/contracts.md) — public API surface, type contracts, and correctness rules
- [Architecture](docs/architecture.md) — layer structure, directory mapping, and dependency graph
- [Behavior Specs](docs/behavior/) — exporter, provider, middleware, context propagation, error handling
- [Langfuse Backend Guide](docs/backends/langfuse.md) — Langfuse-specific configuration and semantic mapping

## Contributing

```bash
pnpm install        # Install dependencies
pnpm test           # Run tests
pnpm lint           # Lint
pnpm format:check   # Check formatting
```

## License

Apache-2.0
