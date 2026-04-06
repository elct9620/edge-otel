import type { ExporterConfig } from "../types.js";

export interface LangfuseOptions {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
}

export interface LangfuseExporterConfig extends ExporterConfig {
  resourceAttributes?: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export function langfuseExporter(
  options: LangfuseOptions,
): LangfuseExporterConfig {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const credentials = btoa(`${options.publicKey}:${options.secretKey}`);

  const config: LangfuseExporterConfig = {
    endpoint: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${credentials}`,
      "x-langfuse-ingestion-version": "4",
    },
  };

  const resourceAttributes: Record<string, string> = {};

  if (options.environment !== undefined) {
    resourceAttributes["deployment.environment.name"] = options.environment;
  }

  if (options.release !== undefined) {
    resourceAttributes["service.version"] = options.release;
  }

  if (Object.keys(resourceAttributes).length > 0) {
    config.resourceAttributes = resourceAttributes;
  }

  return config;
}
