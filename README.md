# @aotoki/edge-otel

[![Tests](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml/badge.svg)](https://github.com/elct9620/edge-otel/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/elct9620/edge-otel/graph/badge.svg)](https://codecov.io/gh/elct9620/edge-otel)

Lightweight OpenTelemetry SDK for V8 isolate edge runtimes (Cloudflare Workers, Vercel Edge Functions, Deno Deploy).

The standard `@opentelemetry/sdk-node` depends on `node:perf_hooks`, `node:async_hooks`, and `node:http`, which are absent or broken in V8 isolate runtimes. This package provides a correct OTel span exporter and tracer provider that works in these environments using only Web Platform APIs (`fetch`, `btoa`) — no Node.js built-ins required.

## Features

- **OTLP/HTTP JSON exporter** — exports spans to any OTLP-compatible collector (Langfuse, Grafana Tempo, Honeycomb, Jaeger, etc.)
- **SimpleSpanProcessor** — per-span buffering with explicit flush, no background timers
- **Context propagation** — `AsyncLocalStorage`-based trace grouping across multiple AI SDK calls
- **Langfuse preset** — pre-configured exporter for Langfuse backend
- **Manual spans** — standard OTel `Tracer` API for custom instrumentation (RAG, DB queries, etc.)
- **Streaming support** — defer flush until the stream is fully consumed

## Install

```bash
pnpm add @aotoki/edge-otel
```

## Quick Start

### Cloudflare Workers

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
const tracer = provider.getTracer("ai");

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
```

## API

### `createTracerProvider(options): TracerProvider`

Creates a tracer provider wired with `SimpleSpanProcessor` and `OtlpHttpJsonExporter`. Options include `endpoint`, `headers`, `serviceName`, and `resourceAttributes`. Returns a provider with `getTracer(scopeName)` and `forceFlush()`.

```typescript
import { createTracerProvider } from "@aotoki/edge-otel";
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

## Documentation

For detailed specifications and design rationale:

- [Specification Overview](SPEC.md) — project scope, user journeys, and feature list
- [API Contracts & Types](docs/contracts.md) — public API surface, type contracts, and correctness rules
- [Architecture](docs/architecture.md) — layer structure, directory mapping, and dependency graph
- [Behavior Specs](docs/behavior/) — exporter, provider, context propagation, error handling
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
