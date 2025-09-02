import { replace } from "esbuild-plugin-replace"
import { defineConfig } from "tsup"
import pkg from "./package.json" with { type: "json" }

export default defineConfig(async (options) => {
  const isWatch = options.watch
  const version = isWatch
    ? pkg.version + "-dev"
    : pkg.version
  console.log(`Building version: ${version}`)
  return {
    entry: ["src/main.ts"],
    clean: true,
    treeshake: "smallest",
    format: ["cjs"],
    target: "node18",
    esbuildPlugins: [
      replace({
        "__VERSION__": `"${version}"`
      })
    ]
  }
})
