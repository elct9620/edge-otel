# Architecture Overview

> Part of [@aotoki/edge-otel specification](../SPEC.md)

## Layer Structure

This is an SDK library, not a web application. Clean Architecture layers are adapted for library design:

| Layer                | Library Equivalent          | Contents                                           |
| -------------------- | --------------------------- | -------------------------------------------------- |
| Entities             | Core types & serialization  | Wire format types, OTLP JSON serializer            |
| Use Cases            | Exporter & Provider factory | Buffer management, provider wiring, TracerProvider |
| Interface Adapters   | Exporters                   | Langfuse exporter preset                           |
| Frameworks & Drivers | OTel SDK packages           | `@opentelemetry/api`, `sdk-trace-base`, etc.       |

## Directory Mapping

```
src/
  index.ts              Core public API barrel
  types.ts              ExporterConfig, TracerProviderOptions, TracerProvider
  serializer.ts         ReadableSpan[] → ExportTraceServiceRequest (pure function)
  provider.ts           createTracerProvider factory → TracerProvider (registers context manager)
  exporters/
    http.ts             OtlpHttpJsonExporter (buffer + flush + POST via fetch)
    langfuse.ts         Langfuse exporter preset — separate entry point
```

## Entry Points

AI SDK natively uses the OTel API, so the core TracerProvider + Exporter is sufficient to capture spans. The Langfuse preset is an **extension** that users import separately:

| Entry Point     | Package Path                           | Contains                                              |
| --------------- | -------------------------------------- | ----------------------------------------------------- |
| Core            | `@aotoki/edge-otel`                    | `createTracerProvider`, `OtlpHttpJsonExporter`, types |
| Langfuse Preset | `@aotoki/edge-otel/exporters/langfuse` | `langfuseExporter`                                    |

## Dependency Guidelines

All dependencies point inward — outer layers depend on inner layers, never the reverse.

```
types.ts              (no deps — pure interfaces)
    ↑
serializer.ts         (no project deps — pure transform)
    ↑
exporters/http.ts     → serializer.ts, types.ts
    ↑
provider.ts           → exporters/http.ts, types.ts, @opentelemetry/context-async-hooks

exporters/langfuse.ts → types.ts (constructs ExporterConfig)
```

Key rules:

- **Exporter presets depend only on types** — they construct `ExporterConfig`, nothing more
- **No circular dependencies** — dependency graph is a DAG
- **Context manager registered inside provider** — `AsyncLocalStorageContextManager` is registered on first `createTracerProvider()` call with a once-guard
