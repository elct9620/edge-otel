# OTLP Span Exporter

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

The exporter accumulates spans in memory during a request and exports them to an OTLP/HTTP JSON endpoint in a single flush after the HTTP response is sent. All network I/O is deferred to the flush operation; no network calls occur during span recording.

---

## Exporter Operations

| Operation       | Trigger                                                           | Contract                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export(spans)` | Called by the span processor after each span ends                 | Appends spans to an in-memory buffer. Returns `SUCCESS` immediately. No network I/O.                                                                                                               |
| `forceFlush()`  | Called explicitly before the isolate exits (e.g. `ctx.waitUntil`) | Drains the buffer atomically, serializes all buffered spans, and POSTs them to the configured endpoint. Resolves without rejecting regardless of outcome. Errors are logged and spans are dropped. |
| `shutdown()`    | Called when the provider is torn down                             | Calls `forceFlush()` to drain any remaining spans, then marks the exporter as closed. Subsequent `export()` calls on a closed exporter are no-ops.                                                 |

**Atomicity of flush**: the buffer is fully drained before the POST begins. If `forceFlush()` is called while the buffer is empty, the operation is a no-op and resolves immediately.

**No retry**: `forceFlush()` makes exactly one POST attempt per flush cycle. Failed spans are dropped.

---

## Wire Format — OTLP/HTTP JSON Encoding Rules

The request body is an `ExportTraceServiceRequest` object. Spans are grouped by resource and instrumentation scope.

| Field                   | Encoding rule                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traceId`               | Lowercase hex string, 32 characters (128-bit identifier)                                                                                                                              |
| `spanId`                | Lowercase hex string, 16 characters (64-bit identifier)                                                                                                                               |
| `parentSpanId`          | Lowercase hex string, 16 characters — **omitted entirely for root spans** (an empty string is incorrect and causes backend rejection)                                                 |
| `startTimeUnixNano`     | Nanosecond-precision Unix epoch encoded as a **decimal string** (not a number — the value exceeds `Number.MAX_SAFE_INTEGER`)                                                          |
| `endTimeUnixNano`       | Nanosecond-precision Unix epoch encoded as a **decimal string** (not a number — the value exceeds `Number.MAX_SAFE_INTEGER`)                                                          |
| `kind`                  | Integer: `1` = INTERNAL, `2` = SERVER, `3` = CLIENT, `4` = PRODUCER, `5` = CONSUMER                                                                                                   |
| Attribute `stringValue` | UTF-8 string                                                                                                                                                                          |
| Attribute `intValue`    | Decimal string (not a number — token counts and other counters may exceed `Number.MAX_SAFE_INTEGER`)                                                                                  |
| Attribute `doubleValue` | JSON number                                                                                                                                                                           |
| Attribute `boolValue`   | JSON boolean                                                                                                                                                                          |
| Attribute `arrayValue`  | Object with a `values` array, each element a typed wrapper                                                                                                                            |
| Attribute `kvlistValue` | Object with a `values` array of `{ key, value }` pairs, each value a typed wrapper                                                                                                    |
| `status.code`           | Integer: `0` = UNSET, `1` = OK, `2` = ERROR                                                                                                                                           |
| Grouping                | Spans sharing the same resource are placed under one `resourceSpans` entry; spans sharing the same instrumentation scope are placed under one `scopeSpans` entry within that resource |

---

## Authentication

The exporter sends configurable HTTP headers with each request. The default authentication scheme is HTTP Basic Auth using the configured credentials (username and password).

| Header          | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| `Authorization` | Configurable; defaults to `Basic <base64(username:password)>` using provided credentials |
| `Content-Type`  | `application/json` — always set; not configurable                                        |

Additional headers may be supplied by the caller to satisfy backend-specific requirements (e.g. API version negotiation). Those headers are documented in the respective backend integration guides.

---

## Constraints

| Constraint           | Value                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Maximum payload size | The exporter does not split payloads. If the endpoint rejects a flush with HTTP 413, all spans from that flush cycle are dropped. |
| Transport            | OTLP/HTTP JSON only — gRPC and protobuf are not used                                                                              |
| Platform APIs        | `fetch()` and `btoa()` only — no Node.js built-ins                                                                                |
| Endpoint path        | `{endpoint}/v1/traces`                                                                                                            |

---

## Error Scenarios

| Scenario                                      | Exporter behavior                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Network failure during POST                   | Log warning; drop all spans from the flush cycle                         |
| HTTP 400 (malformed payload)                  | Log warning; drop all spans — the payload will not become valid on retry |
| HTTP 401 (authentication failure)             | Log warning; drop all spans                                              |
| HTTP 413 (payload too large)                  | Log warning; drop all spans                                              |
| Any other non-2xx response                    | Log warning with the HTTP status code; drop all spans                    |
| `export()` called after `shutdown()`          | No-op — spans are silently discarded, no error is thrown                 |
| Buffer is empty when `forceFlush()` is called | Resolve immediately; no POST is made                                     |

In all failure cases `forceFlush()` resolves (does not reject), preserving the `ctx.waitUntil()` promise chain.
