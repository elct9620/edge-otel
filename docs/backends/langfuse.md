# Backend-Specific Guidance: Langfuse

> Part of [@aotoki/edge-otel specification](../../SPEC.md)

This document defines the Langfuse-specific configuration and interpretation rules. The core specification is backend-agnostic. This preset provides default configuration values and documents the additional HTTP headers and span attributes required by Langfuse.

---

## Exporter Configuration

The Langfuse backend preset supplies the following exporter configuration values.

| Setting               | Value                                 | Notes                                                                                                                                      |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Required header       | `x-langfuse-ingestion-version: 4`     | Activates the fast-path ingestion pipeline. Without this header, spans are processed via the legacy pipeline with up to a 10-minute delay. |
| Endpoint path         | `{baseUrl}/api/public/otel/v1/traces` | Langfuse uses a non-standard OTLP path. The base URL and this path are concatenated by the preset.                                         |
| Default base URL      | `https://cloud.langfuse.com` (EU)     | US: `https://us.cloud.langfuse.com`. HIPAA: contact Langfuse for endpoint.                                                                 |
| Authentication        | HTTP Basic Auth                       | Username: Langfuse public key (`pk-lf-...`). Password: Langfuse secret key (`sk-lf-...`).                                                  |
| Instrumentation scope | `'ai'`                                | Langfuse's token-usage processor requires the instrumentation scope name to be exactly `'ai'` for AI SDK spans.                            |

---

## Preset Configuration

The Langfuse preset accepts the following options. All fields except `publicKey` and `secretKey` are optional.

| Option        | Type     | Required | Description                                                                                    |
| ------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `publicKey`   | `string` | Yes      | Langfuse public key (`pk-lf-...`). Used as the HTTP Basic Auth username.                       |
| `secretKey`   | `string` | Yes      | Langfuse secret key (`sk-lf-...`). Used as the HTTP Basic Auth password.                       |
| `baseUrl`     | `string` | No       | Base URL of the Langfuse instance. Defaults to `https://cloud.langfuse.com` (EU region).       |
| `environment` | `string` | No       | Deployment environment label (e.g., `"production"`, `"staging"`). See Environment and Release. |
| `release`     | `string` | No       | Application release identifier (e.g., `"1.0.0"`, a git SHA). See Environment and Release.      |

### Return Type

The preset returns an object that extends `ExporterConfig` with an optional `resourceAttributes` field.

| Field                | Type                     | Present when                             | Description                                                           |
| -------------------- | ------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `endpoint`           | `string`                 | Always                                   | Full OTLP traces URL for the Langfuse instance.                       |
| `headers`            | `Record<string, string>` | Always                                   | Authorization header and `x-langfuse-ingestion-version: 4`.           |
| `resourceAttributes` | `Record<string, string>` | Only when `environment` or `release` set | OTel resource attributes encoding the environment and release values. |

### Environment and Release via Preset

The `environment` and `release` options are a convenience shortcut for setting OTel resource attributes that Langfuse reads to populate `trace.environment` and `trace.release`. The preset translates these options into the standard OTel resource attribute keys:

| Preset option | OTel resource attribute       | Langfuse field      |
| ------------- | ----------------------------- | ------------------- |
| `environment` | `deployment.environment.name` | `trace.environment` |
| `release`     | `service.version`             | `trace.release`     |

When neither `environment` nor `release` is provided, the preset omits `resourceAttributes` entirely. No empty object is injected.

### Usage Example

Pass the preset return value directly into `createTracerProvider` using the spread operator. `createTracerProvider` merges `resourceAttributes` from the preset with any explicit `resourceAttributes` supplied by the caller; caller-supplied values take priority over preset defaults.

```typescript
import { createTracerProvider } from "@aotoki/edge-otel";
import { langfuseExporter } from "@aotoki/edge-otel/exporters/langfuse";

const provider = createTracerProvider({
  ...langfuseExporter({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    environment: "production",
    release: "1.0.0",
  }),
  serviceName: "my-worker",
});
```

The above is equivalent to writing:

```typescript
const provider = createTracerProvider({
  endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
  headers: {
    /* auth + ingestion-version */
  },
  resourceAttributes: {
    "deployment.environment.name": "production",
    "service.version": "1.0.0",
  },
  serviceName: "my-worker",
});
```

To override the environment set by the preset, supply an explicit `resourceAttributes` object after the spread — the last value for a given key wins under JavaScript object spread semantics:

```typescript
const provider = createTracerProvider({
  ...langfuseExporter({
    publicKey,
    secretKey,
    environment: "production",
    release: "1.0.0",
  }),
  resourceAttributes: {
    "deployment.environment.name": "canary", // overrides preset value
  },
  serviceName: "my-worker",
});
```

---

## Semantic Mapping

This section defines the rules by which Langfuse interprets OTLP spans received at its ingestion endpoint. An implementer must follow these rules precisely — most failures are silent (no HTTP error, no warning in the Langfuse UI) and produce incorrect or absent data rather than a visible error.

---

## Data Model

Every batch of OTLP spans arriving at Langfuse maps onto two entity layers.

| OTLP concept                        | Langfuse entity                                   | Rule                                                                                                       |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| All spans sharing a `traceId`       | One **Trace**                                     | Langfuse groups by `traceId`; each unique `traceId` produces exactly one Trace.                            |
| Span with no `parentSpanId`         | Trace-level observation; source of Trace metadata | The root span is the authoritative source for `userId`, `sessionId`, `tags`, `release`, and `environment`. |
| Span with a `parentSpanId`          | Child **Observation** within the Trace            | `parentSpanId` becomes `parentObservationId` in Langfuse.                                                  |
| Span classified as a generation     | **Generation** observation sub-type               | Has additional fields: `model`, `modelParameters`, `usage`, `cost`, `completionStartTime`.                 |
| Span not classified as a generation | **Span** observation sub-type                     | Generic unit of work; no model or token fields.                                                            |

Langfuse Trace fields (`id`, `name`, `userId`, `sessionId`, `tags`, `release`, `environment`) are populated only from the root span and from spans carrying explicit `langfuse.trace.*` attributes. Attributes on child spans do not propagate up to the Trace entity.

---

## Generation Detection

Langfuse runs `ObservationTypeMapperRegistry` to decide whether each span is a Generation or a plain Span. Mappers execute in priority order; the first match wins.

| Priority     | Condition                                                                                                                   | Classified as |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1            | `langfuse.observation.type` = `"generation"`                                                                                | Generation    |
| 2            | `openinference.span.kind` = `"LLM"`                                                                                         | Generation    |
| 3            | `gen_ai.operation.name` = `"chat"`, `"completion"`, `"text_completion"`, or `"generate_content"`                            | Generation    |
| 4            | Span name starts with `ai.generateText.doGenerate` or `ai.streamText.doStream` **and** instrumentation scope name is `'ai'` | Generation    |
| 5 (fallback) | Any model name attribute (see Model Name Resolution) is present on the span                                                 | Generation    |
| default      | None of the above conditions are met                                                                                        | Span          |

The instrumentation scope name in `scopeSpans[].scope.name` **must be exactly `'ai'`** for the priority 4 path to match. Any other value — including `'@ai-sdk/openai'`, `'vercel-ai'`, or a custom name — causes the mapper to skip priority 4. When priority 4 is skipped, the span may still be classified as a generation via the model-based fallback at priority 5, but the AI SDK–specific token-usage extraction path does not run and token counts are not populated in the structured `usage` field.

---

## Token Usage Attribute Keys

Token counts are mapped to the Generation `usage` field only when the instrumentation scope name is `'ai'` and the correct attribute keys are used.

**Recommended keys** — new implementations should use these:

| Attribute key                    | Langfuse `usage` field             | Applies to scope                   |
| -------------------------------- | ---------------------------------- | ---------------------------------- |
| `gen_ai.usage.input_tokens`      | `usage.input` (prompt tokens)      | `'ai'` scope and all other scopes  |
| `gen_ai.usage.output_tokens`     | `usage.output` (completion tokens) | `'ai'` scope and all other scopes  |
| `gen_ai.usage.prompt_tokens`     | `usage.input` (backward compat)    | `'ai'` scope and all other scopes  |
| `gen_ai.usage.completion_tokens` | `usage.output` (backward compat)   | `'ai'` scope and all other scopes  |
| `ai.usage.tokens`                | `usage.total`                      | `'ai'` scope only                  |
| `ai.usage.cachedInputTokens`     | `usage.cachedInputTokens`          | `'ai'` scope only                  |
| `ai.usage.reasoningTokens`       | `usage.reasoningTokens`            | `'ai'` scope only (Langfuse v3.x+) |

**Legacy keys (obsolete — do not emit in new code):**

| Attribute key               | Langfuse behavior                        | Origin                              |
| --------------------------- | ---------------------------------------- | ----------------------------------- |
| `ai.usage.promptTokens`     | **not mapped** — stored in metadata only | AI SDK < 4.0 (camelCase convention) |
| `ai.usage.completionTokens` | **not mapped** — stored in metadata only | AI SDK < 4.0 (camelCase convention) |

These legacy camelCase keys are not read by Langfuse's structured token path. They appear in the observation's raw metadata only and do not populate the `usage` fields visible in the Langfuse UI. New implementations should always use `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`.

---

## Model Name Resolution

Langfuse checks the following attribute keys in priority order; the first non-empty value populates the Generation's `model` field.

| Priority | Attribute key                     | Source                                             |
| -------- | --------------------------------- | -------------------------------------------------- |
| 1        | `langfuse.observation.model.name` | Langfuse-native override                           |
| 2        | `gen_ai.request.model`            | OTel GenAI semantic convention — requested model   |
| 3        | `gen_ai.response.model`           | OTel GenAI semantic convention — actual model used |
| 4        | `ai.model.id`                     | Vercel AI SDK primary identifier                   |
| 5        | `llm.response.model`              | OpenLLMetry / older conventions                    |

For AI SDK spans, `gen_ai.request.model` is the preferred key. `gen_ai.response.model` is appropriate when the provider returns a different model name from what was requested (e.g., model aliases).

---

## Trace Metadata Attributes

The following span attributes are read by Langfuse to populate Trace and Observation fields. Attributes in the `langfuse.*` namespace take priority over equivalent keys from other namespaces.

| Attribute key                           | Langfuse field                   | Value type                                     | Applies to |
| --------------------------------------- | -------------------------------- | ---------------------------------------------- | ---------- |
| `langfuse.user.id`                      | `trace.userId`                   | String                                         | Root span  |
| `langfuse.session.id`                   | `trace.sessionId`                | String                                         | Root span  |
| `langfuse.trace.tags`                   | `trace.tags`                     | `arrayValue` of strings                        | Root span  |
| `langfuse.trace.input`                  | `trace.input`                    | String or JSON                                 | Root span  |
| `langfuse.trace.output`                 | `trace.output`                   | String or JSON                                 | Root span  |
| `langfuse.trace.metadata.*`             | `trace.metadata.*`               | String                                         | Any span   |
| `langfuse.observation.input`            | `observation.input`              | String or JSON                                 | Any span   |
| `langfuse.observation.output`           | `observation.output`             | String or JSON                                 | Any span   |
| `langfuse.observation.metadata.*`       | `observation.metadata.*`         | String                                         | Any span   |
| `langfuse.observation.level`            | `observation.level`              | `"DEBUG"`, `"DEFAULT"`, `"WARNING"`, `"ERROR"` | Any span   |
| `langfuse.observation.status_message`   | `observation.statusMessage`      | String                                         | Any span   |
| `langfuse.observation.type`             | `observation.type`               | `"generation"`, `"span"`, `"event"`            | Any span   |
| `langfuse.observation.usage_details`    | `observation.usage`              | JSON-encoded usage object                      | Any span   |
| `langfuse.observation.model.name`       | `observation.model`              | String                                         | Any span   |
| `langfuse.observation.model.parameters` | `observation.modelParameters`    | JSON-encoded object                            | Any span   |
| `langfuse.prompt.name`                  | `observation.promptName`         | String                                         | Any span   |
| `langfuse.prompt.version`               | `observation.promptVersion`      | Integer                                        | Any span   |
| `langfuse.internal.as_root`             | Forces span to act as trace root | Boolean `true`                                 | Any span   |

---

## Environment and Release

Resource attributes (set on the `resource.attributes` of the OTLP payload, not on individual spans) control environment and release fields on every Trace in the export batch.

| Resource attribute            | Langfuse field                 |
| ----------------------------- | ------------------------------ |
| `service.version`             | `trace.release`                |
| `deployment.environment.name` | `trace.environment`            |
| `deployment.environment`      | `trace.environment` (fallback) |

---

## Model Parameters Extraction

Generation `modelParameters` are populated from the following span attributes.

| Attribute key                | `modelParameters` field   |
| ---------------------------- | ------------------------- |
| `gen_ai.request.temperature` | `temperature`             |
| `gen_ai.request.max_tokens`  | `maxTokens`               |
| `ai.settings.maxSteps`       | `maxSteps` (AI SDK scope) |

`langfuse.observation.model.parameters` accepts a JSON-encoded object and overrides all individual `gen_ai.request.*` attributes when present.

---

## Observation Level and Error Mapping

The `level` field on an observation is determined in the following order.

| Priority | Source                                                     | Values                                         |
| -------- | ---------------------------------------------------------- | ---------------------------------------------- |
| 1        | `langfuse.observation.level` attribute (explicit override) | `"DEBUG"`, `"DEFAULT"`, `"WARNING"`, `"ERROR"` |
| 2        | `span.status.code` = `2` (ERROR) → inferred                | `"ERROR"`                                      |
| 3        | `span.status.code` = `0` or `1` → default                  | `"DEFAULT"`                                    |

The `statusMessage` field is set from `langfuse.observation.status_message` (priority 1) or `span.status.message` (priority 2).

`"WARNING"` and `"DEBUG"` levels can only be produced via the explicit `langfuse.observation.level` attribute. There is no `span.status.code` value that maps to either.

---

## Soft Error WARNING Attribute

When a soft error occurs (`finishReason = "error"` or `"content-filter"`), the span's `status.code` remains `0` (UNSET) and Langfuse infers level `"DEFAULT"`, hiding the problem. To surface a soft error in Langfuse at WARNING severity without escalating to ERROR, set the following Langfuse-proprietary attributes on the active span:

| Attribute                             | Value                                                             | Effect                                                       |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `langfuse.observation.level`          | `"WARNING"`                                                       | Overrides the inferred level for the observation in Langfuse |
| `langfuse.observation.status_message` | Descriptive string (e.g., `"Generation stopped: content-filter"`) | Populates the `statusMessage` field on the observation       |

Setting `langfuse.observation.level` to `"WARNING"` does not change `span.status.code`, so other OTel backends are not affected. To escalate the same failure to ERROR (in Langfuse and all other backends), set the span's OTel status to ERROR instead — this produces `level = "ERROR"` in Langfuse rather than `"WARNING"`.

---

## Trace-Level Error Propagation

Langfuse sets the trace-level `level` field to the highest severity among all observations in the trace.

| Condition                       | Trace-level outcome                                             |
| ------------------------------- | --------------------------------------------------------------- |
| All observations at `"DEFAULT"` | Trace level is `"DEFAULT"`                                      |
| Any observation at `"WARNING"`  | Trace level is `"WARNING"`                                      |
| Any observation at `"ERROR"`    | Trace level is `"ERROR"` regardless of other observation levels |

**Known risk**: In a multi-step agentic flow, a single failed `doGenerate` span — even one that was a transient failure in an otherwise successful request — marks the entire trace as `"ERROR"`. There is no built-in Langfuse mechanism to suppress a child observation's ERROR from propagating to the trace level. Alerting rules based on trace-level severity should account for this behavior.

---

## AI SDK Tool Call Span Hierarchy

When `generateText` (or `streamText`) uses tools, the Vercel AI SDK emits the following span structure:

```
ai.generateText                     (root span — no parentSpanId)
  ├── ai.generateText.doGenerate    (first LLM call — child of ai.generateText)
  ├── ai.toolCall                   (tool execution — sibling of doGenerate, child of ai.generateText)
  └── ai.generateText.doGenerate    (second LLM call after tool result — child of ai.generateText)
```

Key structural facts:

- `ai.toolCall` spans are **siblings** of `ai.generateText.doGenerate`, not children of it.
- Both `ai.toolCall` and `ai.generateText.doGenerate` spans have `ai.generateText` as their direct parent (`parentSpanId` points to `ai.generateText`).
- In multi-step tool flows, multiple `ai.generateText.doGenerate` and `ai.toolCall` spans are interleaved at the same level under `ai.generateText`.
- The tool call span carries the attribute `ai.toolCall.name` identifying which tool was invoked.

### Langfuse Observation Type for Tool Calls

| Span name                    | Instrumentation scope | Langfuse observation type | Notes                                        |
| ---------------------------- | --------------------- | ------------------------- | -------------------------------------------- |
| `ai.generateText.doGenerate` | `'ai'`                | **Generation**            | Priority 4 in generation detection           |
| `ai.streamText.doStream`     | `'ai'`                | **Generation**            | Priority 4 in generation detection           |
| `ai.toolCall`                | `'ai'`                | **Span**                  | Does not match any generation detection rule |

`ai.toolCall` spans do not match any of the generation detection rules: they carry no model name, no `gen_ai.operation.name`, and their span name does not match the priority 4 prefix. Langfuse classifies them as generic **Span** observations. They appear as children of the `ai.generateText` observation in the Langfuse UI, at the same level as the `doGenerate` generation observations.

### Context Propagation Requirement for Tool Calls

Tool call spans receive their `parentSpanId` from the OTel context that is active when the AI SDK invokes the tool function. If `AsyncLocalStorageContextManager` is not active, the OTel context does not flow into the tool function's async execution path. In that case, the `ai.toolCall` span starts without a parent and gets a new independent `traceId`, causing it to appear as a separate, unrelated trace in Langfuse.

When `AsyncLocalStorageContextManager` is active (registered by `createTracerProvider()`), the context flows automatically into tool functions across `await` boundaries. No additional wrapping is needed — tool call spans are correctly parented to `ai.generateText` without any manual `context.with()` call.

**Known failure mode**: If `nodejs_compat` is not enabled in the deployment, `AsyncLocalStorageContextManager` is unavailable. Tool call spans will float to the root level in Langfuse — each appearing as a separate Trace rather than as a child observation. This is a deployment configuration issue, not a runtime error, and produces no error message; the symptom is orphaned tool call traces in the Langfuse UI. See also: [Langfuse community discussion #6879](https://github.com/langfuse/langfuse/discussions/6879).

---

## Resulting Trace Structure

All spans sharing a `traceId` are grouped by Langfuse into a single Trace entity. The observation tree is determined by the `parentSpanId` relationships in the exported spans.

| Condition                                                   | Langfuse outcome                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| All AI SDK calls share a `traceId`                          | A single Trace appears; the root span is the top-level observation; AI SDK spans appear as children                                 |
| `ai.generateText` and `ai.generateText.doGenerate` spans    | Classified as `generation` observations; token usage appears on each                                                                |
| `ai.toolCall` span with correct `parentSpanId`              | Classified as a **Span** observation; appears as a sibling of `doGenerate` under `ai.generateText` in the Langfuse observation tree |
| `ai.toolCall` span with missing or incorrect `parentSpanId` | Appears as a separate, unrelated Trace in Langfuse; no connection to the parent `ai.generateText` trace                             |
| Token usage across multiple calls                           | Rolled up across all `generation` observations within the Trace                                                                     |
| One call throws an exception                                | That `generation` observation is marked `ERROR`; the Trace-level severity is also elevated to `ERROR`                               |
| AI SDK calls have different `traceId`s (no propagation)     | Each call appears as a separate, unrelated Trace in Langfuse; no token roll-up across calls                                         |

The root span's attributes (for example `langfuse.trace.userId`, `langfuse.trace.sessionId`) propagate to the Trace entity metadata. These attributes should be set on the root span before it ends.

---

## Behavioral Rules

The following rules govern situations where incorrect attribute usage produces silent failures. Each rule is a correctness requirement, not a recommendation.

| #   | Rule                                                                                                                                                                                                                  | Consequence of violation                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Instrumentation scope name **must be `'ai'`** for the Vercel AI SDK token-usage path to run. Any other scope name disables the `'ai'`-specific extraction.                                                            | Token counts are not populated in the Generation `usage` field; they are stored in raw metadata only.   |
| 2   | Token usage attributes (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) **must be on the same span** as the model name attribute. Langfuse does not aggregate usage across spans.                          | The generation appears with no token usage; cross-span aggregation does not occur.                      |
| 3   | `langfuse.trace.tags` **must use `arrayValue` format** — an OTel array attribute with string elements. A plain `stringValue` is not parsed as a tag list.                                                             | Tags are stored in observation metadata only; they do not appear as filterable tags in the Langfuse UI. |
| 4   | `langfuse.observation.level` **overrides** the level inferred from `span.status.code`. Setting it to `"DEFAULT"` on a span with `status.code = 2` (ERROR) suppresses the ERROR level in Langfuse.                     | The observation level in Langfuse does not match the OTel span status.                                  |
| 5   | A root span (no `parentSpanId`) **must be present** in every export batch for Langfuse to build the Trace entity correctly. Trace-level fields (`userId`, `sessionId`, `tags`) are only extracted from the root span. | Langfuse cannot fully construct the Trace entity; trace-level metadata fields are absent.               |
| 6   | The `x-langfuse-ingestion-version: 4` request header **must be sent** with every OTLP POST. Without it, spans are processed via the legacy pipeline.                                                                  | Spans may be delayed up to 10 minutes before appearing in the Langfuse Cloud UI.                        |
| 7   | `ai.usage.promptTokens` and `ai.usage.completionTokens` (camelCase AI SDK legacy keys) are **not** read by the structured token path.                                                                                 | Token counts from older AI SDK spans are absent from the Generation `usage` field.                      |
| 8   | Unknown `gen_ai.usage.*` sub-keys on spans targeting Langfuse instances **older than v3.x** cause the entire span to be dropped from the UI.                                                                          | Affected spans disappear silently from the Langfuse UI on older self-hosted instances.                  |
