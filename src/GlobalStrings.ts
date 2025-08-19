import { AiTool, AiToolkit, McpServer } from "@effect/ai"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Duration, Effect, Layer, pipe, Resource, Schedule, Schema } from "effect"
import fuzzysort from "fuzzysort"

const SupportedGameFlavors = ["mainline", "mists", "vanilla"] as const
type SupportedGameFlavor = typeof SupportedGameFlavors[number]
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
    description: "Searches for global strings keys with content similar to a given query.",
    parameters: {
      query: Schema.String.annotations({
        description:
          "The search query to look for in the global strings, eg; `\"Missing Item\"`, `\"Not enough currency.\"`"
      }),
      threshold: Schema.Number.pipe(Schema.between(0, 1)).annotations({
        description:
          "Threshold to control the strictness of the search. 1 will return perfect matches only, while 0 will return anything.",
        default: 0.3
      })
    },
    success: Schema.Array(
      Schema.Struct({
        globalKey: GlobalStringKey,
        content: GlobalStringContent
      })
    ).annotations({ description: "Array of global strings similar to the query." })
  }),
  AiTool.make("list_global_string_keys", {
    description: "Lists all global string keys for a given game client.",
    parameters: {
      client: Schema.Literal(...SupportedGameFlavors).annotations({
        default: "mainline",
        description: "The WoW game client flavor to list global string keys for."
      })
    },
    success: Schema.Array(GlobalStringKey).annotations({
      description: "Array of global string keys for the specified game client."
    })
  }),
  AiTool.make("get_global_string_contents", {
    description: "Get the translated string contents for a given global string key",
    parameters: {
      globalKey: GlobalStringKey,
      client: Schema.Literal(...SupportedGameFlavors).annotations({
        default: "mainline"
      })
    },
    success: Schema.Record({
      key: Schema.Literal(...SupportedLangCodes).annotations({
        description: "The WoW game client locale code for the translation."
      }),
      value: GlobalStringContent
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
        target: string
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
                  target: content.toLowerCase(),
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
        threshold: number = 0.3,
        flavor: SupportedGameFlavor = "mainline",
        language: SupportedLang = "enUS"
      ) => {
        query = query.toLowerCase()
        return Effect.logDebug("searching").pipe(
          Effect.zipRight(Resource.get(globalStringsByFlavorMap)),
          Effect.map((globalsByFlavor) => {
            const globalMaps = [globalsByFlavor[flavor]]
            const langs = [language]
            return fuzzysort.go(query, createFuzzySearchTargets(globalMaps, langs), { key: "target", threshold }).map((
              x
            ) => x.obj)
          }),
          Effect.annotateLogs("module", "GlobalStrings"),
          Effect.annotateLogs("query", query)
        )
      }

      return toolkit.of({
        find_global_strings: Effect.fn(function*({ query, threshold }) {
          const results = yield* Effect.orDie(search(query, threshold))
          return results.map((result) => ({
            globalKey: result.key,
            content: result.content
            // lang: result.lang
          }))
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
        get_global_string_contents: Effect.fn(function*({ globalKey, client }) {
          const translations = yield* Resource.get(globalStringsByFlavorMap).pipe(
            Effect.map((globalsByFlavor) => {
              const x = globalsByFlavor[client]
              return x[globalKey]
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
