import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts"],
  clean: true,
  treeshake: "smallest",
  format: ["cjs"],
  target: "node18"
})
