import { McpServer } from "@effect/ai"
import { NodeRuntime, NodeSink, NodeStream } from "@effect/platform-node"
import { Layer, Logger } from "effect"
import { GlobalAPIToolKit } from "./GlobalAPIDocs.js"
import { GlobalStringsToolkit } from "./GlobalStrings.js"

McpServer.layerStdio({
  name: "wow-dev-mcp",
  version: "0.0.0",
  stdin: NodeStream.stdin,
  stdout: NodeSink.stdout
}).pipe(
  Layer.provide([GlobalAPIToolKit, GlobalStringsToolkit]),
  Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true }))),
  Layer.launch,
  NodeRuntime.runMain
)
