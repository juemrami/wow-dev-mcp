import { AiTool, AiToolkit, McpSchema, McpServer } from "@effect/ai"
import { HttpBody, HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Cache, Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import { isNotUndefined } from "effect/Predicate"
import fuzzysort from "fuzzysort"
import type { SupportedClientVersion } from "./GlobalStrings.js"
import { ClientVersionParam, SupportedClientVersions } from "./GlobalStrings.js"

const TOOL_DEFAULT_GAME_VERSION: SupportedClientVersion = "mainline"

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
      const getGlobalAPIFileUrl = (version: SupportedClientVersion) =>
        `https://raw.githubusercontent.com/Ketho/BlizzardInterfaceResources/${version}/Resources/GlobalAPI.lua`

      const fetchAndParseApiGlobalsByGameVersion = Effect.fn(function*(version: SupportedClientVersion) {
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
          const apiGlobals = {} as Record<SupportedClientVersion, Array<GlobalAPIName>>
          for (const gameVersion of SupportedClientVersions) {
            apiGlobals[gameVersion] = yield* fetchAndParseApiGlobalsByGameVersion(gameVersion)
          }
          return yield* Effect.succeed(apiGlobals)
        }),
        Schedule.spaced(Duration.hours(1))
      )
      return {
        get: (version: SupportedClientVersion = TOOL_DEFAULT_GAME_VERSION) =>
          Resource.get(cachedGlobalsByGameVersion).pipe(
            Effect.map((globals) => globals[version])
          )
      }
    }),
    dependencies: [NodeHttpClient.layerUndici]
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
        searchApiNames: Effect.fn(function*(query: string, gameVersion?: SupportedClientVersion) {
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
    }),
    dependencies: [GlobalAPIListProvider.Default, NodeHttpClient.layerUndici]
  }
) {}

class WarcraftWikiGGProvider extends Effect.Service<WarcraftWikiGGProvider>()("WarcraftWikiGGProvider", {
  effect: Effect.gen(function*() {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retry(Schedule.spaced(Duration.seconds(3)))
    )
    // Schema colocated here for now; can be moved/shared later if reused.
    const ExpandTemplatesSchema = Schema.Struct({
      expandtemplates: Schema.Struct({
        wikitext: Schema.String
      })
    })

    const expandMediawikiTemplates = (pageContent: string) =>
      pipe(
        Effect.log(`Expanding MediaWiki templates for ${pageContent}`),
        Effect.andThen(
          httpClient.post(`https://warcraft.wiki.gg/api.php`, {
            urlParams: {
              action: "expandtemplates",
              prop: "wikitext",
              format: "json"
            },
            body: HttpBody.text(
              `text=${encodeURIComponent(pageContent)}`,
              "application/x-www-form-urlencoded"
            ),
            headers: { "User-Agent": "wow-dev-mcp/v0" }
          }).pipe(
            Effect.timeout(HTTP_REQUEST_TIMEOUT_DURATION)
          )
        ),
        Effect.andThen(HttpClientResponse.schemaBodyJson(ExpandTemplatesSchema)),
        Effect.andThen((decoded) => decoded.expandtemplates.wikitext)
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
          Effect.andThen((text) => {
            const match = text.match(/(<page>.*<\/page>)/s)
            return match?.[1]
          }),
          Effect.andThen(Effect.fn(function*(pageContent) {
            // yield* Effect.log(`Expanding MediaWiki templates for ${pageContent}`)
            if (pageContent && pageContent.includes("{{")) {
              const expandedContent = yield* expandMediawikiTemplates(
                // this template transcludes to mostly general information about the wiki
                pageContent.replace("{{wowapi}}", "")
              ).pipe(
                Effect.catchTag("ParseError", (err) =>
                  pipe(
                    Effect.logError(`Failed to expand MediaWiki templates for ${requestBody}`, err),
                    Effect.andThen(Effect.succeed(pageContent))
                  )),
                // remove all `<style>`, <font>, <span> tags (useless info)
                Effect.andThen((expandedContent) => expandedContent.replaceAll(/<style\s?.*?>(.*?)<\/style>/gs, "$1")),
                Effect.andThen((expandedContent) => expandedContent.replaceAll(/<font\s?.*?>(.*?)<\/font>/gs, "$1")),
                Effect.andThen((expandedContent) => expandedContent.replaceAll(/<span\s?.*?>(.*?)<\/span>/gs, "$1"))
              )
              return expandedContent
            }
            return pageContent
          }))
        )
      })
    })
    return {
      getWikiPageLink: (page: string) => Effect.succeed(`https://warcraft.wiki.gg/wiki/${page}`),
      /** @param page */
      /** @param curonly if true, only include the current/latest revision of the wiki entry */
      getWikiPageContent: Effect.fn(function*(page: string, curonly: boolean | undefined) {
        return yield* pageContentCache.get(`pages=${encodeURIComponent(page)}&curonly=${curonly ? 1 : 0}`)
      }),
      getLinkedWikiPages: Effect.fn(function*(page: string, curonly: boolean | undefined) {
        const content = yield* pageContentCache.get(`pages=${encodeURIComponent(page)}&curonly=${curonly ? 1 : 0}`)
        if (!content) return []
        // https://www.mediawiki.org/wiki/Help:Links#Internal_links
        const rawInternalLinks = Array.from(content.matchAll(/\[\[(.*?)\]\]/g), (m) => m[1])
        return yield* Effect.forEach(rawInternalLinks, (link) => {
          const linkParts = link.split("|")
          // ignore links with more than 2 parts
          if (linkParts.length > 2) return Effect.succeed(undefined)
          let [linkTarget, displayText] = linkParts
          displayText = displayText?.trim()
          linkTarget = linkTarget.trim()
            .replace(/^:/, "") // remove leading colon if present
            .replace(/^\//, `${page}/`) // handle subpage links
            .replace(/^\.{2}/, `${page.split("/")[0]}/`) // handle `..` subpage navigations
            .replace(/\s/g, "_") // replace spaces with underscores
          return Effect.succeed({ page: linkTarget, title: displayText })
        }).pipe(
          Effect.map((links) => links.filter(isNotUndefined))
        )
      })
    }
  }),
  dependencies: [NodeHttpClient.layerUndici]
}) {}

// Resources
const clientVersionParam = McpSchema.param("clientVersion", Schema.Literal(...SupportedClientVersions))
const ApiListMcpResource = McpServer
  .resource`resource://lua_global_apis/valid_api_names?clientVersion=${clientVersionParam}`({
    name: "Valid global API names by game version",
    mimeType: "application/json",
    description:
      `A dynamic resource that lists all valid global API names, for a given game client version -- one of [${
        SupportedClientVersions.join(", ")
      }]. Intended for human browsing or bulk reasoning, not per-query (use the tool for that).`,
    completion: {
      clientVersion: () => Effect.succeed([...SupportedClientVersions])
    },
    content: (_, clientVersion) =>
      Effect.gen(function*() {
        const globalList = yield* GlobalAPIListProvider
        const apiGlobals = yield* globalList.get(clientVersion).pipe(Effect.orDie)
        return JSON.stringify(apiGlobals, null, 2)
      })
  }).pipe(Layer.provide(GlobalAPIListProvider.Default))

// Tools
const find_global_apis = "search_wow_global_api_names"
const list_valid_global_apis = "list_wow_global_api_names"
const get_global_wiki_info = "get_warcraft_wiki_global_api_info"
const get_warcraft_wiki_page_data = "get_warcraft_wiki_page_data"

const WikiPageData = Schema.Struct({
  url: Schema.String.annotations({
    description: "The URL of the wiki.gg page for the global API."
  }),
  pageContent: Schema.UndefinedOr(Schema.String).annotations({
    description: "The MediaWiki XML <page> export of the global API (if the page has any content)."
  }),
  linkedPages: Schema.Array(Schema.Struct({
    page: Schema.String.annotations({
      description: "The url page slug for the the linked wiki page"
    }),
    title: Schema.UndefinedOr(Schema.String).annotations({
      description: "The displayed text from the source link."
    })
  })).annotations({
    description: "A list of all internally linked wiki page slugs in a given page."
  })
})

const ToolkitSchema = AiToolkit.make(
  AiTool.make(list_valid_global_apis, {
    description: "Lists all global API names for the specified game client version.\
    \n\t`clientVersion`: One of [{{flavors}}], default=\"{{default}}\"\
    ".replace("{{flavors}}", SupportedClientVersions.join(", ")).replace("{{default}}", TOOL_DEFAULT_GAME_VERSION),
    parameters: {
      clientVersion: ClientVersionParam.annotations({ default: TOOL_DEFAULT_GAME_VERSION })
    },
    success: Schema.Array(Schema.String).annotations({
      description: "The list of all valid global API names for a given live game client version"
    })
  }),
  AiTool.make(find_global_apis, {
    description:
      `Searches for any global APIs similar to a given api name(s). Can optionally provide a game client version.\n
    \`query\`: should be a string the global API variable names to search for.\n
    \`clientVersion\`: optional. should be one of [${SupportedClientVersions.join(", ")}].
    `,
    parameters: {
      query: Schema.String.annotations({
        description: "The API call, or similar, to search for. eg \"IsQuestComplete\""
      }),
      clientVersion: Schema.UndefinedOr(ClientVersionParam).annotations({ default: TOOL_DEFAULT_GAME_VERSION })
    },
    success: Schema.Array(Schema.String).annotations({
      description: "The list of nearest global API names found."
    })
  }),
  AiTool.make(get_global_wiki_info, {
    description: `Fetches the warcraft.wiki.gg page for a given global API name.
      This is only useful for api global's who's documented pages would begin with \`API_\`.
      For resources where the \`page\` slug is already known use the \`${get_warcraft_wiki_page_data}\` tool.`,
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
    success: WikiPageData
  }),
  AiTool.make(get_warcraft_wiki_page_data, {
    description: "Fetches the warcraft.wiki.gg page for a given wiki page slug.\
    \nPrefer using this tool when getting wiki content for pages that are not global APIs.\
    \nFor known global APIs use the `%s` tool.".replace("%s", get_global_wiki_info),
    parameters: {
      page: Schema.String.annotations({
        description: "The name of the Warcraft wiki page to fetch. aka the page slug."
      }),
      includeHistory: Schema.UndefinedOr(Schema.Boolean).annotations({
        description:
          "Tool calls should omit this unless specified by user. If true, includes the full history revisions for the wiki page.",
        default: false
      })
    },
    success: WikiPageData
  })
)
const ToolKitLayer = ToolkitSchema.toLayer(
  Effect.gen(function*() {
    const wikiService = yield* WarcraftWikiGGProvider
    const globalList = yield* GlobalAPIListProvider
    const searchService = yield* GlobalAPISearchProvider
    return {
      [list_valid_global_apis]: Effect.fn(function*({ clientVersion }) {
        return yield* globalList.get(clientVersion).pipe(Effect.orDie)
      }),
      [find_global_apis]: Effect.fn(function*({ query, clientVersion }) {
        return yield* searchService.searchApiNames(query, clientVersion).pipe(Effect.orDie)
      }),
      [get_global_wiki_info]: Effect.fn(function*({ apiName, includeHistory }) {
        const [apiPageSlug, currentRevisionOnly] = [`API_${apiName}`, !includeHistory]
        return {
          url: yield* wikiService.getWikiPageLink(apiPageSlug),
          pageContent: yield* wikiService.getWikiPageContent(apiPageSlug, currentRevisionOnly).pipe(Effect.orDie),
          linkedPages: yield* wikiService.getLinkedWikiPages(apiPageSlug, currentRevisionOnly).pipe(Effect.orDie)
        }
      }),
      [get_warcraft_wiki_page_data]: Effect.fn(function*({ page, includeHistory }) {
        const currentRevisionOnly = !includeHistory
        return {
          url: yield* wikiService.getWikiPageLink(page),
          pageContent: yield* wikiService.getWikiPageContent(page, currentRevisionOnly).pipe(Effect.orDie),
          linkedPages: yield* wikiService.getLinkedWikiPages(page, currentRevisionOnly).pipe(Effect.orDie)
        }
      })
    }
  })
).pipe(
  Layer.provide(
    Layer.mergeAll(
      GlobalAPISearchProvider.Default,
      GlobalAPIListProvider.Default,
      WarcraftWikiGGProvider.Default
    )
  ),
  Layer.merge(ApiListMcpResource)
)

export const GlobalAPIToolKit = McpServer.toolkit(ToolkitSchema).pipe(
  Layer.provide(ToolKitLayer)
)
