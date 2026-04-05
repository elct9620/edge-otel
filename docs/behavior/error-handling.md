# Error Handling

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

This section defines how errors surface through the system — from an AI SDK provider call through the span exporter. It covers three distinct error categories, the automatic handling path for thrown exceptions, the gap for soft errors, and the isolation of telemetry failures from the application. See User Journeys 4 and 5 in the main specification for the corresponding end-to-end flows.

---

## Error Categories

| Category                        | Source                                        | Example                                                                         | Handling                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard errors (thrown exceptions) | AI SDK provider calls                         | API authentication failure, rate limit exhausted, network timeout, server error | Automatic — the AI SDK records the exception on the span and sets `status.code = ERROR` before re-throwing; no developer action needed                                                              |
| Soft errors (non-thrown)        | AI SDK returns with a terminal `finishReason` | `finishReason = "error"` or `"content-filter"`                                  | Manual — the developer must inspect `finishReason` after the call returns and set the span's OTel status to ERROR; backend-specific severity attributes are documented in Backend-Specific Guidance |
| Export errors                   | Exporter flush                                | Network failure during POST, HTTP 4xx, payload exceeds 4.5 MB                   | Automatic — logged as a warning and spans are dropped; the application is never notified                                                                                                            |

---

## Automatic Error Handling for Thrown Exceptions

_Corresponds to User Journey 4._

The AI SDK wraps every provider call in an internal span helper. When a provider call throws for any reason, the following happens before the exception propagates to the application:

| Step                                       | Observable outcome                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exception caught by the AI SDK span helper | `recordException(error)` is called — an `"exception"` event is added to the span with `exception.type`, `exception.message`, and `exception.stacktrace`                             |
| Span status set                            | `status.code` is set to `2` (ERROR) with `status.message` set to the error message                                                                                                  |
| Both inner and outer spans marked          | The inner span (e.g., `ai.generateText.doGenerate`) and the outer span (e.g., `ai.generateText`) both receive ERROR status — the exception propagates up through the span hierarchy |
| Exception re-thrown                        | The original exception is re-thrown unchanged to the application's `try/catch`                                                                                                      |

No configuration or manual instrumentation is required for this path. The exporter forwards `status.code` and the exception events as part of the standard OTLP payload. How each backend interprets `status.code = 2` varies — see Backend-Specific Guidance for backend-specific level mapping.

---

## AI SDK Error Types

All AI SDK error classes result in `status.code = 2` on the enclosing span. The `exception.type` attribute in the exception event identifies the failure mode without requiring message parsing.

| Error class                        | Trigger                                                                                              | Span status                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AI_APICallError`                  | HTTP 4xx or 5xx response from the provider (rate limit, auth failure, invalid request, server error) | ERROR — exception recorded on both inner (`doGenerate`) and outer (`generateText`) spans            |
| `AI_RetryError`                    | All retry attempts exhausted; wraps the last `AI_APICallError`                                       | ERROR — only the final failure outcome is visible; individual retry attempts do not appear as spans |
| `AI_LoadAPIKeyError`               | API key missing or not loadable at call time                                                         | ERROR — thrown before any provider span is created; the AI SDK root span reflects the error         |
| `AI_InvalidPromptError`            | Malformed prompt before any network call                                                             | ERROR                                                                                               |
| `AI_NoContentGeneratedError`       | Provider returned HTTP 200 but with empty content                                                    | ERROR                                                                                               |
| `AI_JSONParseError`                | Response body did not match the expected schema for structured output                                | ERROR                                                                                               |
| `AI_UnsupportedFunctionalityError` | Feature not supported by the chosen provider or model                                                | ERROR                                                                                               |

---

## Retry Behavior and Span Visibility

The AI SDK retries transient failures internally (default: up to 2 retries, 3 total attempts). Retries are not individually observable in the span tree.

| Scenario                           | Span outcome                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Retry succeeds on a later attempt  | The `doGenerate` span ends with `status.code = 1` (OK); the intermediate failures leave no trace |
| All retries exhausted              | The `doGenerate` span ends with `status.code = 2` (ERROR) and `exception.type = "AI_RetryError"` |
| `ai.settings.maxRetries` attribute | Always present on the span, regardless of whether any retries occurred                           |

An implementer cannot distinguish a first-attempt success from a third-attempt success in the span data. A `doGenerate` span with `status.code = 2` (ERROR) means all retries were exhausted and the call ultimately failed — not that a single attempt failed.

---

## Soft Error Gap

_Corresponds to User Journey 5._

When a provider returns HTTP 200 but signals a problem via the stream finish reason, the AI SDK may not throw an exception. This is a known gap in the AI SDK telemetry model.

| Condition                                                                | Span state                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `finishReason = "error"` — provider signals error via streaming protocol | `status.code` remains `0` (UNSET) — the problem is not visible |
| `finishReason = "content-filter"` — content blocked mid-stream           | `status.code` remains `0` (UNSET) — the problem is not visible |

The system does not detect soft errors automatically. The developer must inspect `finishReason` after the call returns and decide whether to signal a failure. To make a soft error visible to any OTLP backend, set the span's OTel status to ERROR. Backend-specific severity attributes (e.g., intermediate WARNING levels) are documented in Backend-Specific Guidance.

---

## OTel Status Code Values

The OTel `status.code` values are standard across all backends:

| `status.code` | Value | Meaning                |
| ------------- | ----- | ---------------------- |
| UNSET         | 0     | No explicit status set |
| OK            | 1     | Explicit success       |
| ERROR         | 2     | Explicit failure       |

How each backend interprets and displays these values varies. See Backend-Specific Guidance for backend-specific level mapping and trace-level propagation behavior.

---

## Export Error Isolation

Telemetry failures are fully isolated from the application. This is a correctness requirement, not a best-effort policy.

| Rule                                                             | Rationale                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `forceFlush()` never rejects                                     | A rejecting promise interrupts the `ctx.waitUntil()` chain and leaves the Worker isolate in an undefined state |
| Export errors are logged as warnings                             | The application has no notification mechanism for telemetry failures; logging is the only observable signal    |
| Spans from a failed flush are dropped                            | No retry is attempted; the 30-second `waitUntil` budget is not sufficient for retry logic                      |
| The HTTP response is never delayed or altered by a flush failure | The flush executes after the response is returned, inside `ctx.waitUntil()`                                    |

Export error scenarios are fully specified in the [OTLP Span Exporter — Error Scenarios](exporter.md#error-scenarios) table.
