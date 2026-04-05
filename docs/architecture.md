# Architecture Overview

> Part of [@aotoki/edge-otel specification](../SPEC.md)

## Layer Structure

This is an SDK library, not a web application. Clean Architecture layers are adapted for library design:

| Layer                | Library Equivalent          | Contents                                         |
| -------------------- | --------------------------- | ------------------------------------------------ |
| Entities             | Core types & serialization  | Wire format types, OTLP JSON serializer          |
| Use Cases            | Exporter & Provider factory | Buffer management, provider wiring, TracerHandle |
| Interface Adapters   | Middleware & Exporters      | Hono middleware, Langfuse exporter preset        |
| Frameworks & Drivers | OTel SDK packages           | `@opentelemetry/api`, `sdk-trace-base`, etc.     |

## Directory Mapping

```
src/
  index.ts              Core public API barrel
  types.ts              ExporterConfig, TracerProviderOptions, TracerHandle
  serializer.ts         ReadableSpan[] → ExportTraceServiceRequest (pure function)
  exporter.ts           OtlpHttpJsonExporter (buffer + flush + POST via fetch)
  provider.ts           createTracerProvider factory → TracerHandle
  context.ts            AsyncLocalStorageContextManager module-scope registration
  middleware/
    hono.ts             createHonoMiddleware — separate entry point
  exporters/
    langfuse.ts         Langfuse exporter preset — separate entry point
```

## Entry Points

AI SDK natively uses the OTel API, so the core TracerProvider + Exporter is sufficient to capture spans. Hono middleware and Langfuse preset are **extensions** that users import separately:

| Entry Point     | Package Path                           | Contains                                              |
| --------------- | -------------------------------------- | ----------------------------------------------------- |
| Core            | `@aotoki/edge-otel`                    | `createTracerProvider`, `OtlpHttpJsonExporter`, types |
| Hono Middleware | `@aotoki/edge-otel/middleware/hono`    | `createHonoMiddleware`                                |
| Langfuse Preset | `@aotoki/edge-otel/exporters/langfuse` | `langfusePreset`                                      |

## Dependency Guidelines

All dependencies point inward — outer layers depend on inner layers, never the reverse.

```
types.ts              (no deps — pure interfaces)
    ↑
serializer.ts         (no project deps — pure transform)
    ↑
exporter.ts           → serializer.ts, types.ts
    ↑
context.ts            (no project deps — side-effect module)
    ↑
provider.ts           → exporter.ts, context.ts, types.ts

middleware/hono.ts    → types.ts (receives TracerHandle)
exporters/langfuse.ts → types.ts (constructs ExporterConfig)
```

Key rules:

- **Middleware does NOT depend on provider** — it receives a `TracerHandle`, not the factory module
- **Exporters presets depend only on types** — they construct `ExporterConfig`, nothing more
- **No circular dependencies** — dependency graph is a DAG
- **`context.ts` is a side-effect import** — imported for its module-scope registration, not for exports
