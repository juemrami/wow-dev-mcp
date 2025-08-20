// how are we gonna get the urls

import { AiTool, AiToolkit, McpServer } from "@effect/ai"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import fuzzysort from "fuzzysort"
import type { SupportedGameFlavor } from "./GlobalStrings.js"
import { SupportedGameFlavors } from "./GlobalStrings.js"

type GlobalAPIName = string
const findSimilarGlobals = (
  query: string,
  targets: Array<{
    key: GlobalAPIName
    target: string
  }>
) => {
  const results = fuzzysort.go(query, targets, {
    threshold: 0.1,
    limit: 100,
    key: "target"
  })
  console.error("query:", query)
  console.error("Fuzzy search results:", results)
  return results.reduce((acc, res) => {
    acc.push(res.obj.key)
    return acc
  }, [] as Array<GlobalAPIName>)
}
const getGlobalAPIFileUrl = (flavor: SupportedGameFlavor) =>
  `https://raw.githubusercontent.com/Ketho/BlizzardInterfaceResources/${flavor}/Resources/GlobalAPI.lua`

const find_global_apis = "find_global_apis"
const Toolkit = AiToolkit.make(
  AiTool.make(find_global_apis, {
    description: `Searches for any global APIs similar to a given api name(s). Can optionally provide a game version.\n
    \`query\`: should be a string the global API variable names to search for.\n
    \`gameVersion\`: optional. should be one of [${SupportedGameFlavors.join(", ")}].
    `,
    parameters: {
      query: Schema.String.annotations({
        description: "The API call, or similar, to search for. eg \"IsQuestComplete\""
      }),
      gameVersion: Schema.UndefinedOr(Schema.Literal(...SupportedGameFlavors)).annotations({
        description: `The game version to filter the search by. One of [${SupportedGameFlavors.join(", ")}]`,
        default: "mainline"
      })
    },
    success: Schema.Array(Schema.String).annotations({
      description: "The list of nearest global API names found."
    })
  })
)
const ToolKitLayer = Toolkit.toLayer(
  Effect.gen(function*() {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retry(Schedule.spaced(Duration.seconds(3)))
    )
    const fetchAndParseApiGlobalsByGameVersion = Effect.fn(function*(version: SupportedGameFlavor) {
      const text = yield* pipe(
        httpClient.get(getGlobalAPIFileUrl(version)),
        Effect.andThen(HttpClientResponse.filterStatusOk),
        Effect.flatMap((r) => r.text)
      )

      const apiGlobals = [] as Array<GlobalAPIName>
      for (const line of text.split("\n")) {
        if (line.match(/[{}]/)) continue // ignore lines with braces { }
        if (line.trim().length === 0) continue // ignore empty lines
        const match = line.match(/"(\w+)"/)
        if (match) {
          apiGlobals.push(match[1])
        }
      }
      return apiGlobals
    })

    const apiGlobalsByGameVersion = yield* Resource.auto(
      Effect.gen(function*() {
        const apiGlobals = {} as Record<SupportedGameFlavor, Array<GlobalAPIName>>
        for (const gameVersion of SupportedGameFlavors) {
          // Implement the logic to fetch and parse the API globals by game version
          apiGlobals[gameVersion] = yield* fetchAndParseApiGlobalsByGameVersion(gameVersion)
        }
        return yield* Effect.succeed(apiGlobals)
      }),
      Schedule.spaced(Duration.hours(1))
    )
    // Todo: move away from string manipulation and use a different text matching library
    // required because fuzzysort is unreliable with CamelCase similarity rankings.
    const wordifyAPI = (name: string) => {
      const [namespace, apiName] = name.split(".", 2)
      const toWords = (string: string) =>
        string
          .replace(/([A-Z])/g, " $1") // Add space before capital letters
          .replace(/[._]/g, " ") // Replace dots/underscores with spaces
          .replace(/\s+/g, " ") // Replace multiple spaces with a single space
          .trim().toLowerCase()
      if (!apiName) {
        return toWords(namespace)
      } else {
        return namespace.concat(" ", toWords(apiName))
      }
    }
    const cachedWordify = yield* Effect.cachedFunction((name: string) => Effect.succeed(wordifyAPI(name)))
    const generateGlobalSearchObject = yield* Effect.cachedFunction((name: GlobalAPIName) =>
      Effect.succeed({
        key: name,
        target: wordifyAPI(name)
      })
    )
    return {
      [find_global_apis]: Effect.fn(function*({ query, gameVersion }) {
        const availableGlobals = (yield* apiGlobalsByGameVersion.pipe(Effect.orDie))[gameVersion ?? "mainline"]
        // Split query into multiple queries if separated by whitespace, |, or -
        // Note: alot of LLM's seem to think that the tool should accept multiple queries at once in a single query param.
        // stupid llms.
        const queries = query.split(/[\s|-]+/).filter((q) => q.trim().length > 0)

        const searchObjects = yield* Effect.forEach(
          availableGlobals,
          generateGlobalSearchObject
        )

        // Process each query and collect results
        const queryResults: Array<Array<GlobalAPIName>> = []
        for (const singleQuery of queries) {
          const results = findSimilarGlobals(
            yield* cachedWordify(singleQuery),
            searchObjects
          )
          queryResults.push(results)
        }

        // Round-robin interleave results from each query
        const finalResults: Array<GlobalAPIName> = []
        const seenResults = new Set<GlobalAPIName>()
        const maxLength = Math.max(...queryResults.map((results) => results.length))

        for (let i = 0; i < maxLength; i++) {
          for (const results of queryResults) {
            if (i < results.length && !seenResults.has(results[i])) {
              finalResults.push(results[i])
              seenResults.add(results[i])
            }
          }
        }

        return finalResults.slice(0, 100) as ReadonlyArray<GlobalAPIName>
      })
    }
  })
).pipe(Layer.provide(NodeHttpClient.layerUndici))

export const GlobalAPIToolKit = McpServer.toolkit(Toolkit).pipe(
  Layer.provide(ToolKitLayer)
)
