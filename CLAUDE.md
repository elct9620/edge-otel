# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@aotoki/edge-otel` — A lightweight OpenTelemetry SDK for V8 isolate edge runtimes (Cloudflare Workers, Vercel Edge Functions, Deno Deploy). Uses only Web Platform APIs (`fetch`, `btoa`); no Node.js built-ins.

## Commands

```bash
pnpm build          # Build with tsdown (rolldown-based, ESM-only output)
pnpm test           # Run all tests (vitest)
pnpm test:watch     # Watch mode
pnpm lint           # ESLint with typescript-eslint
pnpm lint:fix       # ESLint auto-fix
pnpm format         # Prettier
pnpm format:check   # Prettier check
```

Run a single test file: `pnpm vitest run tests/path/to/file.test.ts`

## Architecture

This is a **specification-driven** project. Read the specs before implementing:

- `SPEC.md` — Table of contents linking to all specification documents
- `docs/contracts.md` — Public API surface, type contracts, wire format, 10 correctness rules
- `docs/behavior/` — Detailed behavior specs (provider, exporter, context, error-handling)
- `docs/backends/` — Backend-specific guidance (e.g., Langfuse semantic mapping)
- `docs/architecture.md` — Layer structure, directory mapping, dependency graph

### Entry Points

The package has 2 separate entry points. Core captures AI SDK spans natively; the Langfuse exporter is an opt-in extension:

| Entry Point       | Package Path                           | Source                      |
| ----------------- | -------------------------------------- | --------------------------- |
| Core              | `@aotoki/edge-otel`                    | `src/index.ts`              |
| Langfuse Exporter | `@aotoki/edge-otel/exporters/langfuse` | `src/exporters/langfuse.ts` |

### Dependency Direction

All imports point inward. Outer modules never import inner modules' peers:

```
types.ts ← serializer.ts ← exporters/http.ts ← provider.ts
                                                    ↑
                                              @opentelemetry/context-async-hooks
exporters/langfuse.ts → types.ts only
```

- `provider.ts` registers `AsyncLocalStorageContextManager` on first `createTracerProvider()` call (once-guard, no side-effect import).
- `exporters/langfuse.ts` constructs an `ExporterConfig`, nothing more.

### Key Constraints

- **No global registration** — never call `provider.register()`; pass tracer directly
- **SimpleSpanProcessor only** — no `BatchSpanProcessor` (no background timers in isolates)
- **`forceFlush()` always resolves** — telemetry failures are logged via `console.warn`, never reject
- **Use `forceFlush()` per request**, not `shutdown()`; register via `ctx.waitUntil()`
- **Timestamps as nanosecond decimal strings** — string concatenation, not arithmetic (avoids `MAX_SAFE_INTEGER` overflow)
- **`ExporterConfig.endpoint` is a full URL** — the exporter uses it as-is; presets construct the complete path
