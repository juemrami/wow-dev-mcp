#!/usr/bin/env -S node --experimental-strip-types
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { FileSystem } from "@effect/platform/FileSystem"
import { Effect } from "effect"
import * as path from "node:path"

const destinationPath = path.join("dist", "package.json")
const srcPath = "package.json"
const program = Effect.gen(function*() {
  const fs = yield* FileSystem
  const cleanedJson = yield* fs.readFileString(srcPath).pipe(
    Effect.map((s) => JSON.parse(s)),
    Effect.map((json) => ({
      name: json.name,
      version: json.version,
      tag: json.tag,
      license: json.license,
      description: json.description,
      repository: json.repository,
      author: json.author,
      bin: {
        "wow-dev-mcp": path.parse(json.bin["wow-dev-mcp"]).base
      }
    }))
  )
  return yield* fs.writeFileString(destinationPath, JSON.stringify(cleanedJson, null, 2)).pipe(
    Effect.tap(() => console.log(`bundle-package-json: Cleaned \`${srcPath}\` and copied to \`${destinationPath}\`.`))
  )
})

Effect.runPromise(program.pipe(
  Effect.provide(NodeFileSystem.layer)
))
