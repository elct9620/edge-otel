import { describe, it, expect } from "vitest";
import { langfuseExporter } from "../../src/exporters/langfuse.js";

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";

describe("langfuseExporter", () => {
  // -------------------------------------------------------------------------
  // Endpoint URL
  // -------------------------------------------------------------------------

  describe("endpoint URL", () => {
    it("uses the Langfuse cloud base URL by default", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(config.endpoint).toBe(
        "https://cloud.langfuse.com/api/public/otel/v1/traces",
      );
    });

    it("appends the OTLP path to a custom baseUrl", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        baseUrl: "https://self-hosted.example.com",
      });

      expect(config.endpoint).toBe(
        "https://self-hosted.example.com/api/public/otel/v1/traces",
      );
    });

    it("handles a custom baseUrl with a trailing slash correctly", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        baseUrl: "https://self-hosted.example.com/",
      });

      // The exporter does simple string concatenation; a trailing slash produces
      // a double-slash in the path.  This test documents the actual behaviour
      // so that any future change (e.g. trimming the slash) is a deliberate
      // decision rather than an accidental regression.
      expect(config.endpoint).toBe(
        "https://self-hosted.example.com//api/public/otel/v1/traces",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Authorization header
  // -------------------------------------------------------------------------

  describe("Authorization header", () => {
    it("sets Authorization to Basic with base64-encoded credentials", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      const expectedCredentials = btoa(`${PUBLIC_KEY}:${SECRET_KEY}`);
      expect(config.headers?.["Authorization"]).toBe(
        `Basic ${expectedCredentials}`,
      );
    });

    it("encodes credentials correctly for known key pair", () => {
      const config = langfuseExporter({
        publicKey: "pk-lf-abc123",
        secretKey: "sk-lf-xyz789",
      });

      // btoa("pk-lf-abc123:sk-lf-xyz789") = "cGstbGYtYWJjMTIzOnNrLWxmLXh5ejc4OQ=="
      expect(config.headers?.["Authorization"]).toBe(
        "Basic cGstbGYtYWJjMTIzOnNrLWxmLXh5ejc4OQ==",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Langfuse ingestion header
  // -------------------------------------------------------------------------

  describe("x-langfuse-ingestion-version header", () => {
    it("sets x-langfuse-ingestion-version to '4'", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(config.headers?.["x-langfuse-ingestion-version"]).toBe("4");
    });
  });

  // -------------------------------------------------------------------------
  // Return type shape
  // -------------------------------------------------------------------------

  describe("return type", () => {
    it("returns an object with a string endpoint", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(typeof config.endpoint).toBe("string");
    });

    it("returns an object with a headers record", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(config.headers).toBeDefined();
      expect(typeof config.headers).toBe("object");
    });

    it("does not include resourceAttributes when neither environment nor release is set", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(Object.keys(config).sort()).toEqual(["endpoint", "headers"]);
      expect(config.resourceAttributes).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Resource attributes
  // -------------------------------------------------------------------------

  describe("resourceAttributes", () => {
    it("maps environment to deployment.environment.name", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        environment: "production",
      });

      expect(config.resourceAttributes).toEqual({
        "deployment.environment.name": "production",
      });
    });

    it("maps release to service.version", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        release: "1.0.0",
      });

      expect(config.resourceAttributes).toEqual({
        "service.version": "1.0.0",
      });
    });

    it("includes both attributes when environment and release are both set", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        environment: "staging",
        release: "2.3.4",
      });

      expect(config.resourceAttributes).toEqual({
        "deployment.environment.name": "staging",
        "service.version": "2.3.4",
      });
    });

    it("omits resourceAttributes entirely when neither environment nor release is provided", () => {
      const config = langfuseExporter({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect("resourceAttributes" in config).toBe(false);
    });
  });
});
