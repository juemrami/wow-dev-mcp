#!/usr/bin/env -S node --experimental-strip-types
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { FileSystem } from "@effect/platform/FileSystem"
import { Duration, Effect, Layer, pipe } from "effect"
import fastglob from "fast-glob"
import * as path from "node:path"

const SCRIPT_LABEL = "bundle-package-json"
const projectRoot = "." // script is expected to be ran from projectRoot
const srcPackageJsonPath = path.join(projectRoot, "package.json")
const destinationDir = path.join(projectRoot, "dist")
const destinationPackageJsonPath = path.join(destinationDir, "package.json")

const useFastGlobEffect = <A>(
  use: (fg: typeof fastglob) => Promise<A> | A
) =>
  Effect.tryPromise({
    try: async () => await use(fastglob),
    catch: (e) => new Error(`Failed to use fast-glob: ${(e as Error).message}`)
  })

class SrcPackageContents extends Effect.Service<SrcPackageContents>()(
  "@build/package-contents-provider",
  {
    effect: Effect.gen(function*() {
      const fs = yield* FileSystem
      const content = yield* fs.readFileString(srcPackageJsonPath)
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content),
        catch: (e) => new Error(`Invalid JSON in ${srcPackageJsonPath}: ${(e as Error).message}`)
      })
      return { packageDotJson: parsed }
    })
  }
) {}
const copyPackageJson = Effect.gen(function*() {
  const fs = yield* FileSystem
  const pkg = (yield* SrcPackageContents).packageDotJson
  const cleanedJson = yield* pipe(
    Effect.succeed({
      name: pkg.name,
      version: pkg.version,
      tag: pkg.tag,
      license: pkg.license,
      description: pkg.description,
      repository: pkg.repository,
      author: pkg.author,
      bin: {
        "wow-dev-mcp": path.parse(pkg.bin["wow-dev-mcp"]).base
      }
    })
  )
  return yield* fs.writeFileString(destinationPackageJsonPath, JSON.stringify(cleanedJson, null, 2)).pipe()
}).pipe(
  Effect.tap(() =>
    console.log(
      `${SCRIPT_LABEL}: copied modified \`${srcPackageJsonPath}\` to \`${destinationPackageJsonPath}\``
    )
  )
)

const copyPackageJsonFiles = Effect.gen(function*() {
  const pkg = (yield* SrcPackageContents).packageDotJson
  const fs = yield* FileSystem
  if (pkg.files === undefined) return
  if (pkg.files[0] === undefined) return
  if (typeof pkg.files[0] !== "string") {
    throw new Error("package.json.files field is missing or malformed.")
  }
  const getPaths = (doDirectories: boolean) =>
    useFastGlobEffect(
      (fg) =>
        fg(pkg.files, {
          cwd: projectRoot,
          dot: true,
          onlyDirectories: doDirectories,
          absolute: true,
          ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.jj/**"]
        })
    )
  const matchedPaths = (yield* Effect.all([getPaths(true), getPaths(false)], { concurrency: "unbounded" })).flat()
  yield* Effect.forEach(matchedPaths, (file) =>
    Effect.gen(function*() {
      const dest = path.join(destinationDir, path.basename(file))
      const exists = yield* fs.exists(file)
      if (!exists) return
      const dir = yield* fs.readDirectory(file).pipe(
        Effect.catchTag("SystemError", (e) =>
          e.description?.startsWith("ENOTDIR") ? Effect.succeed(false) : Effect.fail(e))
      )
      if (dir !== false) {
        yield* fs.copy(file, dest)
      } else yield* fs.copyFile(file, dest)
      console.log(`${SCRIPT_LABEL}: copied ${dir ? "directory" : "file"} \`${path.parse(file).name}\` to \`${dest}\``)
    }), { concurrency: "unbounded" })
})

const program = pipe(
  copyPackageJson,
  Effect.andThen(() => copyPackageJsonFiles),
  Effect.provide(
    Layer.provideMerge(SrcPackageContents.Default, NodeFileSystem.layer)
  )
)

Effect.runPromise(pipe(
  Effect.timed(program),
  Effect.andThen(([duration]) => {
    return console.log(`${SCRIPT_LABEL}: completed in ${Duration.toMillis(duration).toFixed(2)}ms`)
  })
))
