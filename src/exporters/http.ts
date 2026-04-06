import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ExporterConfig } from "../types.js";
import { serializeSpans } from "../serializer.js";

export class OtlpHttpJsonExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private buffer: ReadableSpan[] = [];
  private isShutdown = false;

  constructor(config: ExporterConfig) {
    this.endpoint = config.endpoint;
    this.headers = config.headers ?? {};
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    this.buffer.push(...spans);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async forceFlush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const spans = this.buffer.splice(0);

    try {
      const body = JSON.stringify(serializeSpans(spans));
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body,
      });
      if (!response.ok) {
        console.warn(
          "[edge-otel] span export failed:",
          response.status,
          response.statusText,
        );
      }
    } catch (error) {
      console.warn("[edge-otel] span export failed:", error);
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.isShutdown = true;
  }
}
