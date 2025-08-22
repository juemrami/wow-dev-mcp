import { AiTool, AiToolkit, McpSchema, McpServer } from "@effect/ai"
import { HttpBody, HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Cache, Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import fuzzysort from "fuzzysort"
import type { SupportedGameFlavor } from "./GlobalStrings.js"
import { SupportedGameFlavors } from "./GlobalStrings.js"

// // find linked api pages in a api description xml response
// const findLinkedPages = (response: string) => {
//   const templatesTemplate = /{{(.*?)}}/g
//   for (const match of response.matchAll(templatesTemplate)) {
//     const templateContent = match[1]
//     const isAPITemplate = templateContent.startsWith("api|")
//     const infoMatch = templateContent.match(infoFromTemplate)
//     if (infoMatch) {
//       const apiName = infoMatch[1]
//       const apiType = infoMatch[2] || "a"
//       // Do something with apiName and apiType
//     }
//   }
// }
const HTTP_REQUEST_TIMEOUT_DURATION = Duration.seconds(15)
const WIKI_PAGE_CACHE_DURATION = Duration.hours(1)
type GlobalAPIName = string

class GlobalAPIListProvider extends Effect.Service<GlobalAPIListProvider>()(
  "@app/GlobalAPIListProvider",
  {
    scoped: Effect.gen(function*() {
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retry(Schedule.spaced(Duration.seconds(3)))
      )
      const getGlobalAPIFileUrl = (flavor: SupportedGameFlavor) =>
        `https://raw.githubusercontent.com/Ketho/BlizzardInterfaceResources/${flavor}/Resources/GlobalAPI.lua`

      const fetchAndParseApiGlobalsByGameVersion = Effect.fn(function*(version: SupportedGameFlavor) {
        const text = yield* pipe(
          httpClient.get(getGlobalAPIFileUrl(version)),
          Effect.timeout(HTTP_REQUEST_TIMEOUT_DURATION),
          Effect.andThen(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.text)
        )
        const collectedGlobals = [] as Array<GlobalAPIName>
        for (const line of text.split("\n")) {
          if (line.match(/[{}]/)) continue // ignore lines with braces { }
          if (line.trim().length === 0) continue // ignore empty lines
          const match = line.match(/"(\w+)"/)
          if (match) {
            collectedGlobals.push(match[1])
          }
        }
        return collectedGlobals
      })

      const cachedGlobalsByGameVersion = yield* Resource.auto(
        Effect.gen(function*() {
          const apiGlobals = {} as Record<SupportedGameFlavor, Array<GlobalAPIName>>
          for (const gameVersion of SupportedGameFlavors) {
            apiGlobals[gameVersion] = yield* fetchAndParseApiGlobalsByGameVersion(gameVersion)
          }
          return yield* Effect.succeed(apiGlobals)
        }),
        Schedule.spaced(Duration.hours(1))
      )
      return {
        get: (gameVersion: SupportedGameFlavor = "mainline") =>
          Resource.get(cachedGlobalsByGameVersion).pipe(
            Effect.map((globals) => globals[gameVersion])
          )
      }
    })
  }
) {}

class GlobalAPISearchProvider extends Effect.Service<GlobalAPISearchProvider>()(
  "@app/GlobalAPISearchProvider",
  {
    effect: Effect.gen(function*() {
      const globalList = yield* GlobalAPIListProvider
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
      // Todo: move away from string manipulation and use a different text matching library
      // required because fuzzysort is unreliable with CamelCase similarity rankings.
      const wordifyAPI = (name: string) => {
        const [namespace, apiName] = name.split(".", 2)
        const toWords = (string: string) =>
          string
            .replace(/([A-Z]+)/g, " $1") // Add space before capital letters (ignore CAPS sequences)
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
      const generateSearchObject = yield* Effect.cachedFunction((name: GlobalAPIName) =>
        Effect.succeed({
          key: name,
          target: wordifyAPI(name)
        })
      )
      return {
        searchApiNames: Effect.fn(function*(query: string, gameVersion?: SupportedGameFlavor) {
          const availableGlobals = yield* globalList.get(gameVersion)
          // Split query into multiple queries if separated by whitespace, |, or -
          // Note: alot of LLM's seem to think the tool should accept multiple queries at once in a single query. stupid llms.
          const queries = query.split(/[\s|-]+/).filter((q) => q.trim().length > 0)
          // Process each query and collect results
          const queryResults: Array<Array<GlobalAPIName>> = []
          const searchObjects = yield* Effect.forEach(availableGlobals, generateSearchObject)
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
          // Only return top 100 to not pollute model's context
          return finalResults.slice(0, 100) as ReadonlyArray<GlobalAPIName>
        })
      }
    })
  }
) {}

class WarcraftWikiGGProvider extends Effect.Service<WarcraftWikiGGProvider>()("WarcraftWikiGGProvider", {
  effect: Effect.gen(function*() {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retry(Schedule.spaced(Duration.seconds(3)))
    )
    const pageContentCache = yield* Cache.make({
      capacity: 3000, // Generous capacity
      timeToLive: WIKI_PAGE_CACHE_DURATION,
      lookup: Effect.fn(function*(requestBody: string) {
        const url = `https://warcraft.wiki.gg/wiki/Special:Export`
        const response = yield* httpClient.post(url, {
          // Adding content type in the headers doesnt work, have to add it in the body
          body: HttpBody.text(
            requestBody,
            "application/x-www-form-urlencoded"
          ),
          headers: {
            "User-Agent": "wow-dev-mcp/v0"
            // "Content-Type": "application/x-www-form-urlencoded",
          }
        }).pipe(Effect.timeout(Duration.seconds(12)))

        return yield* pipe(
          HttpClientResponse.filterStatusOk(response),
          Effect.flatMap((r) => r.text),
          // Note: For now just extract the <page> content since the rest is mostly extraneous
          Effect.map((text) => {
            const match = text.match(/(<page>.*<\/page>)/s)
            return match?.[1]
          })
        )
      })
    })
    return {
      getWikiPageLink: (page: string) => Effect.succeed(`https://warcraft.wiki.gg/wiki/${page}`),
      /** @param page */
      /** @param curonly if true, only include the current/latest revision of the wiki entry */
      getWikiPageContent: Effect.fn(function*(page: string, curonly: boolean | undefined) {
        return yield* pageContentCache.get(`pages=${encodeURIComponent(page)}&curonly=${curonly ? 1 : 0}`)
      })
    }
  })
}) {}

const gameVersionParam = McpSchema.param("gameVersion", Schema.Literal(...SupportedGameFlavors))
const ApiListMcpResource = McpServer
  .resource`resource://lua_global_apis/valid_api_names?gameVersion=${gameVersionParam}`({
    name: "Valid global API names by game version",
    mimeType: "application/json",
    description:
      `A dynamic resource that lists all valid global API names for a given game version. The game version can be one of [${
        SupportedGameFlavors.join(", ")
      }]. Intended for human browsing or bulk reasoning, not per-query (use the tool for that)`,
    completion: {
      gameVersion: () => Effect.succeed([...SupportedGameFlavors])
    },
    content: (_, gameVersion) =>
      Effect.gen(function*() {
        const globalList = yield* GlobalAPIListProvider
        const apiGlobals = yield* globalList.get(gameVersion).pipe(Effect.orDie)
        return JSON.stringify(apiGlobals, null, 2)
      })
  })

const find_global_apis = "find_global_apis"
const get_global_wiki_info = "get_global_api_wiki_info"
const list_valid_global_apis = "list_valid_global_apis"

const ToolkitSchema = AiToolkit.make(
  AiTool.make(list_valid_global_apis, {
    description: `Lists all global APIs for the specified game version.`,
    parameters: {
      gameVersion: Schema.Literal(...SupportedGameFlavors).annotations({
        description: `The game version to filter the search by. One of [${SupportedGameFlavors.join(", ")}]`,
        default: "mainline"
      })
    },
    success: Schema.Array(Schema.String).annotations({
      description: "The list of all valid global API names for a given live game version client"
    })
  }),
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
  }),
  AiTool.make(get_global_wiki_info, {
    description: `Fetches the wiki.gg page for a global API name.`,
    parameters: {
      apiName: Schema.String.annotations({
        description: "The name of the global API to fetch the wiki page for."
      }),
      includeHistory: Schema.UndefinedOr(Schema.Boolean).annotations({
        description:
          "Tool calls should omit this unless specified by user. If true, includes the full history revisions for the wiki page.",
        default: false
      })
    },
    success: Schema.Struct({
      url: Schema.String.annotations({
        description: "The URL of the wiki.gg page for the global API."
      }),
      pageContent: Schema.UndefinedOr(Schema.String).annotations({
        description: "The MediaWiki XML <page> export of the global API (if the page has any content)."
      })
      // links
    })
  })
)
const ToolKitLayer = ToolkitSchema.toLayer(
  Effect.gen(function*() {
    const wikiService = yield* WarcraftWikiGGProvider
    const globalList = yield* GlobalAPIListProvider
    const searchService = yield* GlobalAPISearchProvider
    return {
      [list_valid_global_apis]: Effect.fn(function*({ gameVersion }) {
        return yield* globalList.get(gameVersion).pipe(Effect.orDie)
      }),
      [find_global_apis]: Effect.fn(function*({ query, gameVersion }) {
        return yield* searchService.searchApiNames(query, gameVersion).pipe(Effect.orDie)
      }),
      [get_global_wiki_info]: Effect.fn(function*({ apiName, includeHistory }) {
        const apiPageSlug = `API_${apiName}`
        return {
          url: yield* wikiService.getWikiPageLink(apiPageSlug),
          pageContent: yield* wikiService.getWikiPageContent(apiPageSlug, !includeHistory).pipe(Effect.orDie)
        }
      })
    }
  })
).pipe(
  Layer.provideMerge(ApiListMcpResource),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.provideMerge(GlobalAPISearchProvider.Default, GlobalAPIListProvider.Default),
      WarcraftWikiGGProvider.Default
    )
  ),
  Layer.provide(NodeHttpClient.layerUndici)
)

export const GlobalAPIToolKit = McpServer.toolkit(ToolkitSchema).pipe(
  Layer.provide(ToolKitLayer)
)
