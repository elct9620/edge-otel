import type { ExporterConfig } from "../types.js";

export interface LangfuseOptions {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export function langfusePreset(options: LangfuseOptions): ExporterConfig {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const credentials = btoa(`${options.publicKey}:${options.secretKey}`);

  return {
    endpoint: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${credentials}`,
      "x-langfuse-ingestion-version": "4",
    },
  };
}
