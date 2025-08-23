import { AiTool, AiToolkit, McpServer } from "@effect/ai"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import fuzzysort from "fuzzysort"

const DEFAULT_SEARCH_THRESHOLD = 0.08
const DEFAULT_WOW_LOCALE = "enUS"
const FUZZY_SEARCH_KEY = "target"
const DEFAULT_SEARCH_RESULT_LIMIT = 25

// For now this param can simply map to the available branches in ketho's BlizzardInterfaceResources repo
export const SupportedClientVersions = ["mainline", "mists", "vanilla"] as const
export type SupportedClientVersion = typeof SupportedClientVersions[number]
export const ClientVersionParam = Schema.Literal(...SupportedClientVersions).annotations({
  description: "Abstract key for the valid game version to target when querying client specific data. \
  \n\t`mainline`: The main live version of the game, colloquially known as 'retail wow'.\
  \n\t`vanilla`: The original version of the game, cka 'vanilla wow', 'classic wow', 'classic era'/'era'.\
  \n\t`mists`: The latest classic expansion, currently 'Mists of Pandaria' aka 'mop'/'mop classic'.\
  "
})
const TOOL_DEFAULT_CLIENT_VERSION: SupportedClientVersion = "mainline"

const SupportedClientLocales = [
  "enUS",
  "frFR",
  "deDE",
  "esMX",
  "itIT",
  "koKR",
  "ptBR",
  "ruRU",
  "zhCN",
  "zhTW"
] as const
type SupportedClientLocale = typeof SupportedClientLocales[number]

const getGlobalStringFileUrl = (flavor: SupportedClientVersion, lang: SupportedClientLocale) =>
  `https://raw.githubusercontent.com/Ketho/BlizzardInterfaceResources/refs/heads/${flavor}/Resources/GlobalStrings/${lang}.lua`

const GlobalStringKey = Schema.String.annotations({
  description: "The unique in-game lua environment global variable name for the string"
})

const GlobalStringContent = Schema.String.annotations({
  description: "The content of the global string for in a specific language."
})
const search_global_strings = "search_wow_global_strings"
const list_global_strings = "list_wow_global_string_keys"
const get_string_translations = "get_wow_global_string_translations"

const toolkit = AiToolkit.make(
  AiTool.make(search_global_strings, {
    description: "Searches for global strings keys with content similar to a given plaintext query. \
    \n\tFor 1-2 word queries, use `threshold` (e.g. [0.2, 0.5]) (lower for fuzzier results). \
    \n\tFor longer queries, a lower `threshold` (e.g. 0.08 to 0) and a higher result `limit` may be more appropriate. \
    \ne.g; \
    \n\tIf a user want strings similar to a label, \"Hide Delisted Entries\", they might use: \
    \n\t\t- `threshold: 0.1`, `limit: 30` \
    \n\tIf a user want strings similar to a longer phrase, like \"Alt+Click to Request to Join Group\", they might use: \
    \n\t\t- `threshold: 0`, `limit: 200` \
    \n\t\t- this will get top 200 closest matches. \
    \n\tIf as user wants near exact matches, say for smaller labels like \"This Week\", they might use: \
    \n\t\t- `threshold: 0.8`, `limit: 20` \
    \n\t\t- this will only get top 20 results with more than 80% similarity.\
    ",
    parameters: {
      query: Schema.String.annotations({
        description: "The query to match against existing global strings. \
          Expected single words or simple phrases eg; `\"Missing Item\"`, `\"Not enough currency.\"`"
      }),
      threshold: Schema.UndefinedOr(
        Schema.Number.pipe(Schema.between(0, 1))
      ).annotations({
        description: "Threshold to control the strictness of the search. \
        \nRecommendations: \
        \n\t* <= 0.8 for any exact matches; \
        \n\t* 0.5 for single word queries; \
        \n\t* =0.2 for 2-3 word queries; \
        \n\t* >= 0.08 for phrases.",
        default: DEFAULT_SEARCH_THRESHOLD
      }),
      limit: Schema.UndefinedOr(
        Schema.Number.pipe(Schema.between(0, 100))
      ).annotations({
        description: "The maximum number of results to return. 0 means no limit.",
        default: DEFAULT_SEARCH_RESULT_LIMIT
      })
    },
    success: Schema.Record({
      key: GlobalStringKey,
      value: Schema.partial(Schema.Record({
        key: Schema.Literal(...SupportedClientLocales),
        value: GlobalStringContent
      }))
    }).annotations({ description: "A record of global strings matching the given query params, by global key." })
  }),
  AiTool.make(list_global_strings, {
    description: "Lists all global string **keys** for a given game client version.",
    parameters: {
      clientVersion: ClientVersionParam.annotations({ default: TOOL_DEFAULT_CLIENT_VERSION })
    },
    success: Schema.Array(GlobalStringKey).annotations({
      description: "Array of global string keys available in the specified game client."
    })
  }),
  AiTool.make(get_string_translations, {
    description: "Get the translated string contents for the given _set_ of global string keys, and a game version.",
    parameters: {
      globalKeys: Schema.Array(GlobalStringKey),
      clientVersion: ClientVersionParam.annotations({ default: TOOL_DEFAULT_CLIENT_VERSION })
    },
    success: Schema.Record({
      key: GlobalStringKey,
      value: Schema.partial(Schema.Record({
        key: Schema.Literal(...SupportedClientLocales).annotations({
          description: "The WoW game client locale code for the translation."
        }),
        value: GlobalStringContent
      }))
    }).annotations({
      description: "The translations for a global string in all supported client languages."
    })
  })
)
type GlobalKey = string
const ToolkitLayer = toolkit
  .toLayer(
    Effect.gen(function*() {
      const docsClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retry(Schedule.spaced(Duration.seconds(3)))
      )

      const loadResourceFileContents = (url: string) =>
        pipe(
          docsClient.get(url),
          Effect.andThen(HttpClientResponse.filterStatusOk),
          Effect.andThen((res) => res.text)
        )
      const createTranslationMapForFlavor = (flavor: SupportedClientVersion) =>
        pipe(
          Effect.forEach(SupportedClientLocales, (lang) =>
            loadResourceFileContents(getGlobalStringFileUrl(flavor, lang)).pipe(
              // Files are lua files. global variables are declared as
              // `_G[<key>] = "<value>";` or `<key> = "<value>";`. 1 per line.
              Effect.andThen((rawText) => {
                const globalStringMapping: Record<string, string> = {}
                rawText.split("\n").forEach((line) => {
                  const match = line.match(/^(?:_G\[)?(.+?)\s*=\s*"(.+?)";?$/)
                  if (match) {
                    const key = match[1]
                    const value = match[2]
                    globalStringMapping[key] = value
                  }
                })
                return { [lang]: globalStringMapping }
              })
            )),
          Effect.andThen((x) => {
            const acc = {} as Record<GlobalKey, Record<SupportedClientLocale, string>>
            for (const languageMapping of x) {
              for (const [lang, globalStringMap] of Object.entries(languageMapping)) {
                for (const [key, value] of Object.entries(globalStringMap)) {
                  acc[key] = acc[key] || {} as Record<SupportedClientLocale, string>
                  acc[key][lang as SupportedClientLocale] = value
                }
              }
            }
            return acc
          })
        )
      const globalStringsByFlavorMap = yield* Resource.auto(
        Effect.gen(function*() {
          const globalStringsForFlavor = yield* Effect.forEach(
            SupportedClientVersions,
            (flavor) =>
              createTranslationMapForFlavor(flavor).pipe(
                Effect.map((x) => ({ [flavor]: x }))
              )
          ).pipe(Effect.andThen((x) => {
            const final = {} as Record<SupportedClientVersion, Record<GlobalKey, Record<SupportedClientLocale, string>>>
            for (const flavorMap of x) {
              for (const [flavor, map] of Object.entries(flavorMap)) {
                final[flavor as SupportedClientVersion] = map
              }
            }
            return final
          }))
          return globalStringsForFlavor
        }),
        Schedule.spaced(Duration.hours(3))
      )

      type FuzzyResult = {
        key: string
        [FUZZY_SEARCH_KEY]: string
        content: string
        lang: SupportedClientLocale
      }
      function createFuzzySearchTargets(
        globalMaps: Array<
          Record<
            string,
            Record<SupportedClientLocale, string>
          >
        >,
        langs: Array<SupportedClientLocale>
      ): ReadonlyArray<FuzzyResult> {
        const targets: Array<FuzzyResult> = []
        for (const globalMap of globalMaps) {
          for (const [globalKey, translations] of Object.entries(globalMap)) {
            for (const lang of langs) {
              const content = translations[lang as SupportedClientLocale]
              if (content) {
                targets.push({
                  key: globalKey,
                  [FUZZY_SEARCH_KEY]: content.toLowerCase(),
                  content,
                  lang: lang as SupportedClientLocale
                })
              }
            }
          }
        }
        return targets
      }

      const search = (
        query: string,
        threshold: number = DEFAULT_SEARCH_THRESHOLD,
        limit: number = DEFAULT_SEARCH_RESULT_LIMIT,
        flavor: SupportedClientVersion = TOOL_DEFAULT_CLIENT_VERSION,
        language: SupportedClientLocale = DEFAULT_WOW_LOCALE
      ) => {
        query = query.toLowerCase()
        return Effect.logDebug("searching").pipe(
          Effect.zipRight(Resource.get(globalStringsByFlavorMap)),
          Effect.map((globalsByFlavor) => {
            const globalMaps = [globalsByFlavor[flavor]]
            const langs = [language]
            return fuzzysort.go(query, createFuzzySearchTargets(globalMaps, langs), {
              key: FUZZY_SEARCH_KEY,
              threshold,
              limit
            }).map((
              x
            ) => x.obj)
          }),
          Effect.annotateLogs("module", "GlobalStrings"),
          Effect.annotateLogs("query", query)
        )
      }

      return toolkit.of({
        [search_global_strings]: Effect.fn(function*({ query, threshold, limit }) {
          const results = yield* Effect.orDie(search(query, threshold, limit))
          return results.reduce((acc, result) => {
            acc[result.key] = acc[result.key] || {}
            acc[result.key][result.lang] = result.content
            return acc
          }, {} as Record<GlobalKey, Record<SupportedClientLocale, string>>)
        }),
        [list_global_strings]: Effect.fn(function*({ clientVersion }) {
          const keys = yield* Resource.get(globalStringsByFlavorMap).pipe(
            Effect.map((globalsByGameVersion) => {
              const x = globalsByGameVersion[clientVersion]
              return Object.keys(x)
            }),
            Effect.orDie
          )
          return keys
        }),
        [get_string_translations]: Effect.fn(function*({ globalKeys, clientVersion }) {
          const translations = yield* Resource.get(globalStringsByFlavorMap).pipe(
            Effect.map((globalsByGameVersion) => {
              const clientGlobals = globalsByGameVersion[clientVersion]
              const result: Record<string, Record<SupportedClientLocale, string>> = {}

              for (const key of globalKeys) {
                if (clientGlobals[key]) {
                  result[key] = clientGlobals[key]
                }
              }

              return result
            }),
            Effect.orDie
          )
          return translations
        })
      })
    })
  )
  .pipe(Layer.provide(NodeHttpClient.layerUndici))

export const GlobalStringsToolkit = McpServer.toolkit(toolkit).pipe(
  Layer.provide(ToolkitLayer)
)
