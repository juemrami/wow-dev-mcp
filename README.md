# WoW UI Development MCP Server

A Model Context Protocol (MCP) server for World of Warcraft development tools.

## Quick Install

<!-- Cursor deeplink json (to be base64 encoded) -->
<!--
{
    "wow-dev-mcp": {
        "type": "stdio",
        "command": "docker",
        "args": [
            "run",
            "--rm",
            "-i",
            "juemrami/wow-dev-mcp"
        ]
    }
}
-->
<!-- https://cursor.com/install-mcp?name={{name}}&config={{base64encodedjson}} -->
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=docker-dev-mcp&config=eyJjb21tYW5kIjoiZG9ja2VyIiwiYXJncyI6WyJydW4iLCItLXJtIiwiLWkiLCJqdWVtcmFtaS93b3ctZGV2LW1jcCJdfQ==)

<!-- Vscode deeplink json (to be uri encoded) -->
<!--
{
    "name": "wow-dev-mcp",
    "gallery": false,
    "command": "docker",
    "args": ["run", "--rm", "-i", "juemrami/wow-dev-mcp"]
}
-->
<!-- vscode:mcp/install?{{uriencodedjson}} -->
[![Install to VScode](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=wow-dev-mcp&config=%7B%22name%22%3A%22wow-dev-mcp%22%2C%22gallery%22%3Afalse%2C%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22--rm%22%2C%22-i%22%2C%22juemrami%2Fwow-dev-mcp%22%5D%7D)

### Claude Code (run command)
```bash
claude mcp add-json wow-dev-mcp '{
  "command": "npx",
  "args": [
    "-y",
    "wow-dev-mcp@latest"
  ],
  "env": {}
}' -s user
```
## General Installation
Available on npm registry and dockerhub via
> Note: Use these command and args following your specific mcp client's (vscode/cursor/etc) configuration
```bash
npx -y wow-dev-mcp
```
```bash
docker run --rm -i juemrami/wow-dev-mcp
```
## Available Tools
### Global Strings Toolkit
- **Search Global Strings `search_wow_global_strings`** – Fuzzy search global string contents matching the provided `query`.
- **List Global String Keys `list_wow_global_string_keys`** – List all global string keys for a game client version.
- **Get String Translations `get_wow_global_string_translations`** – Retrieve translations for the specified `globalKeys`.

Support following WoW game client locales (will vary by client version):
- `enUS` - English (US)
- `frFR` - French
- `deDE` - German
- `esMX` - Spanish (Mexico)
- `itIT` - Italian
- `koKR` - Korean
- `ptBR` - Portuguese (Brazil)
- `ruRU` - Russian
- `zhCN` - Chinese (Simplified)
- `zhTW` - Chinese (Traditional)

### Global API Toolkit
- **Search Global API Names `search_wow_global_api_names`** – Fuzzy search global API names matching the provided `query`.
- **List Global API Names `list_wow_global_api_names`** – List all valid global API names for a client version.

#### Warcraft Wiki Related Tools

- **Get Global API Wiki Info `get_warcraft_wiki_global_api_info`** – Fetch wiki page content and links (related _page_ slugs) for the given `apiName`.
- **Get Warcraft Wiki Page Data `get_warcraft_wiki_page_data`** – Fetch wiki page content and links for the given `page` slug.

Both toolkits support multiple WoW game client flavors:
- `mainline` - Current retail version
- `classic` - Progression Classic, as of October 2026: Mists of Pandaria
- `vanilla` - Classic Era (incl. Hardcore/Season of Discovery)
- `tbc` - Anniversary realms, as of October 2026: The Burning Crusade
- `forever` - Warcraft Forever

### Selecting a game flavor

Every tool that reads client data takes an optional `clientVersion` parameter.
It defaults to `mainline`, so retail needs no mention. For any other client the
agent has to pass the key:

| Tool | Takes `clientVersion` |
|---|---|
| `search_wow_global_api_names` | yes |
| `list_wow_global_api_names` | yes |
| `search_wow_global_strings` | yes |
| `list_wow_global_string_keys` | yes |
| `get_wow_global_string_translations` | yes |
| `get_warcraft_wiki_global_api_info` | no, the wiki is not versioned |
| `get_warcraft_wiki_page_data` | no |

The agent decides which key to pass from your prompt, so name the client
when it is not retail:

- "Search the TBC Anniversary API for arena team functions" → `clientVersion: "tbc"`
- "Which global strings mention Hardcore on Classic Era?" → `clientVersion: "vanilla"`
- "List the Classic Forever API names" → `clientVersion: "forever"`

For an addon project, put the flavor in the agent's project instructions once
(for example `CLAUDE.md`, `.cursorrules` or `copilot-instructions.md`) so every
call uses it:

    This addon targets Mists of Pandaria Classic. Use clientVersion "classic"
    for all wow-dev-mcp calls.

If the agent can read the addon's `.toc` file, the `## Interface` number tells
it the flavor:

| Interface | Flavor |
|---|---|
| `12xxxx` | `mainline` |
| `5xxxx` | `classic` |
| `2xxxx` | `tbc` |
| `16xxx` | `forever` |
| `11xxx` | `vanilla` |

The full API name list is also exposed as an MCP resource per flavor, for
clients that support resources:

    resource://lua_global_apis/valid_api_names/<flavor>

### Known Issues
 - you may have to try really hard to get your llm to use optional tool parameters correctly. Depends on model.

## Development

### Requirements

    pnpm@10.14.0

### Install from Source

### Setup example Vscode

To use this mcp server in dev with, for example VS Code and GitHub Copilot:
1. Open VS Code
2. Open the User or Workspace `mcp.json` config file

- Using the command palette, search for and select:
    -  **"MCP: Open User Configuration"**
    - or **"MCP: Open Workspace Configuration"**
4. Modify the `servers` section by adding the the project as a stdio mcp server:

```js
{
"servers" : {
    // ... other mcp servers
    "wow-dev-mcp": {
        "type": "stdio",
        "command": "pnpm",
        // replace 'path/to/project' with your actual project path
        "args": [
            "tsx",
            "--watch",
            "path/to/project/src/main.ts"
        ]
    }
}
}
```

**Building**

```bash
pnpm build
```

**Testing**

```bash
pnpm vitest
```

## Credits

- Global strings directory referenced from https://github.com/Ketho/BlizzardInterfaceResources
