# Changelog

## [0.2.0](https://github.com/elct9620/edge-otel/compare/edge-otel-v0.1.0...edge-otel-v0.2.0) (2026-04-06)


### ⚠ BREAKING CHANGES

* `createHonoMiddleware` and the `@aotoki/edge-otel/middleware/hono` entry point have been removed. Use `tracer.startActiveSpan()` directly to manage root span lifecycle.

### Bug Fixes

* **release:** add last-release-sha to prevent false changelog entries ([6b7ff47](https://github.com/elct9620/edge-otel/commit/6b7ff4733271d3137450ccb26693f01ae6117b85))


### Miscellaneous Chores

* release 0.2.0 ([d58025d](https://github.com/elct9620/edge-otel/commit/d58025d0a298febe06ef0b3078ff129c7cb4701c))


### Code Refactoring

* remove Hono middleware in favor of user-managed root spans ([ab2e6c7](https://github.com/elct9620/edge-otel/commit/ab2e6c78c461ed9e474422bc50d3a2903a641dac))
