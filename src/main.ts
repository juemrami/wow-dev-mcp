#!/usr/bin/env node

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  yield* Console.log("WoW Dev MCP Server starting...")
  // TODO: Add MCP server implementation here
})

Effect.runPromise(program)
