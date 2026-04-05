import { describe, it, expect } from "vitest";
import { langfusePreset } from "../../src/exporters/langfuse.js";

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";

describe("langfusePreset", () => {
  // -------------------------------------------------------------------------
  // Endpoint URL
  // -------------------------------------------------------------------------

  describe("endpoint URL", () => {
    it("uses the Langfuse cloud base URL by default", () => {
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(config.endpoint).toBe(
        "https://cloud.langfuse.com/api/public/otel/v1/traces",
      );
    });

    it("appends the OTLP path to a custom baseUrl", () => {
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        baseUrl: "https://self-hosted.example.com",
      });

      expect(config.endpoint).toBe(
        "https://self-hosted.example.com/api/public/otel/v1/traces",
      );
    });

    it("handles a custom baseUrl with a trailing slash correctly", () => {
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
        baseUrl: "https://self-hosted.example.com/",
      });

      // The preset does simple string concatenation; a trailing slash produces
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
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      const expectedCredentials = btoa(`${PUBLIC_KEY}:${SECRET_KEY}`);
      expect(config.headers?.["Authorization"]).toBe(
        `Basic ${expectedCredentials}`,
      );
    });

    it("encodes credentials correctly for known key pair", () => {
      const config = langfusePreset({
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
      const config = langfusePreset({
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
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(typeof config.endpoint).toBe("string");
    });

    it("returns an object with a headers record", () => {
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(config.headers).toBeDefined();
      expect(typeof config.headers).toBe("object");
    });

    it("does not include unexpected top-level keys", () => {
      const config = langfusePreset({
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      });

      expect(Object.keys(config).sort()).toEqual(["endpoint", "headers"]);
    });
  });
});
