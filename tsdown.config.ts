import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/exporters/langfuse.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
