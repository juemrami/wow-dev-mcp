import { AiTool, AiToolkit, McpServer } from "@effect/ai"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import fuzzysort from "fuzzysort"

const DEFAULT_SEARCH_THRESHOLD = 0.08
const DEFAULT_CLIENT_VERSION_FLAVOR = "mainline"
const DEFAULT_WOW_LOCALE = "enUS"
const FUZZY_SEARCH_KEY = "target"
const DEFAULT_SEARCH_RESULT_LIMIT = 25

export const SupportedGameFlavors = ["mainline", "mists", "vanilla"] as const
export type SupportedGameFlavor = typeof SupportedGameFlavors[number]
const SupportedLangCodes = [
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
type SupportedLang = typeof SupportedLangCodes[number]

const getGlobalStringFileUrl = (flavor: SupportedGameFlavor, lang: SupportedLang) =>
  `https://raw.githubusercontent.com/Ketho/BlizzardInterfaceResources/refs/heads/${flavor}/Resources/GlobalStrings/${lang}.lua`

const GlobalStringKey = Schema.String.annotations({
  description: "The unique in-game lua environment global variable name for the string"
})

const GlobalStringContent = Schema.String.annotations({
  description: "The content of the global string for in a specific language."
})

const toolkit = AiToolkit.make(
  AiTool.make("find_global_strings", {
    description: `Searches for global strings keys with content similar to a given plaintext query.
      For 1-2 word queries, use \`threshold\` (e.g. [0.2, 0.5]) (lower for fuzzier results).
      For longer queries, a lower \`threshold\` (e.g. 0.08 to 0) and a higher result \`limit\` may be more appropriate.
      eg:\n
        If a user want strings similar to a label, "Hide Delisted Entries", they might use:\n
          - \`threshold: 0.1\`, \`limit: 30\`\n
        If a user want strings similar to a longer phrase, like "Alt+Click to Request to Join Group", they might use:\n
          - \`threshold: 0\`, \`limit: 200\`\n
          - this will get top 200 closest matches.\n
        If as user wants near exact matches, say for smaller labels like "This Week", they might use:\n
          - \`threshold: 0.8\`, \`limit: 20\`\n
          - this will only get top 20 results with more than 80% similarity.\n
    `,
    parameters: {
      query: Schema.String.annotations({
        description:
          "The query to match against existing global strings. Expected single words or simple phrases eg; `\"Missing Item\"`, `\"Not enough currency.\"`"
      }),
      threshold: Schema.UndefinedOr(
        Schema.Number.pipe(Schema.between(0, 1))
      ).annotations({
        description: `Threshold to control the strictness of the search.
          Recommendations:
            <= 0.8 for any exact matches;
            =0.5 for single word queries;
            =0.2 for 2-3 word queries;
            >= 0.08 for phrases.`,
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
        key: Schema.Literal(...SupportedLangCodes),
        value: GlobalStringContent
      }))
    }).annotations({ description: "A record of global strings matching the given query params, by global key." })
  }),
  AiTool.make("list_global_string_keys", {
    description: "Lists all global string keys for a given game client.",
    parameters: {
      client: Schema.Literal(...SupportedGameFlavors).annotations({
        default: DEFAULT_CLIENT_VERSION_FLAVOR,
        description: "The WoW game client flavor to list global string keys for."
      })
    },
    success: Schema.Array(GlobalStringKey).annotations({
      description: "Array of global string keys for the specified game client."
    })
  }),
  AiTool.make("get_global_strings_for_keys", {
    description: "Get the translated string contents for a given a _set_ global string keys and client flavor",
    parameters: {
      globalKeys: Schema.Array(GlobalStringKey),
      client: Schema.Literal(...SupportedGameFlavors).annotations({
        default: DEFAULT_CLIENT_VERSION_FLAVOR
      })
    },
    success: Schema.Record({
      key: GlobalStringKey,
      value: Schema.partial(Schema.Record({
        key: Schema.Literal(...SupportedLangCodes).annotations({
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
      const createTranslationMapForFlavor = (flavor: SupportedGameFlavor) =>
        pipe(
          Effect.forEach(SupportedLangCodes, (lang) =>
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
            const acc = {} as Record<GlobalKey, Record<SupportedLang, string>>
            for (const languageMapping of x) {
              for (const [lang, globalStringMap] of Object.entries(languageMapping)) {
                for (const [key, value] of Object.entries(globalStringMap)) {
                  acc[key] = acc[key] || {} as Record<SupportedLang, string>
                  acc[key][lang as SupportedLang] = value
                }
              }
            }
            return acc
          })
        )
      const globalStringsByFlavorMap = yield* Resource.auto(
        Effect.gen(function*() {
          const globalStringsForFlavor = yield* Effect.forEach(
            SupportedGameFlavors,
            (flavor) =>
              createTranslationMapForFlavor(flavor).pipe(
                Effect.map((x) => ({ [flavor]: x }))
              )
          ).pipe(Effect.andThen((x) => {
            const final = {} as Record<SupportedGameFlavor, Record<GlobalKey, Record<SupportedLang, string>>>
            for (const flavorMap of x) {
              for (const [flavor, map] of Object.entries(flavorMap)) {
                final[flavor as SupportedGameFlavor] = map
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
        lang: SupportedLang
      }
      function createFuzzySearchTargets(
        globalMaps: Array<
          Record<
            string,
            Record<SupportedLang, string>
          >
        >,
        langs: Array<SupportedLang>
      ): ReadonlyArray<FuzzyResult> {
        const targets: Array<FuzzyResult> = []
        for (const globalMap of globalMaps) {
          for (const [globalKey, translations] of Object.entries(globalMap)) {
            for (const lang of langs) {
              const content = translations[lang as SupportedLang]
              if (content) {
                targets.push({
                  key: globalKey,
                  [FUZZY_SEARCH_KEY]: content.toLowerCase(),
                  content,
                  lang: lang as SupportedLang
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
        flavor: SupportedGameFlavor = DEFAULT_CLIENT_VERSION_FLAVOR,
        language: SupportedLang = DEFAULT_WOW_LOCALE
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
        find_global_strings: Effect.fn(function*({ query, threshold, limit }) {
          const results = yield* Effect.orDie(search(query, threshold, limit))
          return results.reduce((acc, result) => {
            acc[result.key] = acc[result.key] || {}
            acc[result.key][result.lang] = result.content
            return acc
          }, {} as Record<GlobalKey, Record<SupportedLang, string>>)
        }),
        list_global_string_keys: Effect.fn(function*({ client }) {
          const keys = yield* Resource.get(globalStringsByFlavorMap).pipe(
            Effect.map((globalsByFlavor) => {
              const x = globalsByFlavor[client]
              return Object.keys(x)
            }),
            Effect.orDie
          )
          return keys
        }),
        get_global_strings_for_keys: Effect.fn(function*({ globalKeys, client }) {
          const translations = yield* Resource.get(globalStringsByFlavorMap).pipe(
            Effect.map((globalsByFlavor) => {
              const clientGlobals = globalsByFlavor[client]
              const result: Record<string, Record<SupportedLang, string>> = {}

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
