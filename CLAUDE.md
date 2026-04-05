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
- `docs/behavior/` — Detailed behavior specs (provider, exporter, middleware, context, error-handling)
- `docs/backends/` — Backend-specific guidance (e.g., Langfuse semantic mapping)

### Public API (6 exports)

1. `createTracerProvider(options)` → `TracerHandle` (tracer + flush + rootSpan helper)
2. `OtlpHttpJsonExporter` — OTLP/HTTP JSON exporter (advanced use)
3. `createHonoMiddleware()` — Hono framework middleware

### Key Constraints

- **No global registration** — never call `provider.register()`; pass tracer directly
- **SimpleSpanProcessor only** — no `BatchSpanProcessor` (no background timers in isolates)
- **AsyncLocalStorageContextManager** registered at module scope, before first request
- **`flush()` always resolves** — telemetry failures never reject the application promise
- **Use `forceFlush()` per request**, not `shutdown()`; register via `ctx.waitUntil()`
- Timestamps as nanosecond decimal strings (avoid `MAX_SAFE_INTEGER` overflow)

### Directory Layout

- `src/` — Source code (TypeScript, ESM)
- `tests/` — Test files (`*.test.ts`)
- `docs/` — Specification documents (read-only reference, not generated)
