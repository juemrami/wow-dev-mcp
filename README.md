# WoW UI Development MCP Server

A Model Context Protocol (MCP) server for World of Warcraft development tools.

## Requirements

    pnpm@10.14.0

## Installation

1. Clone or download this repository
2. Install dependencies and build the project:

```bash
pnpm install --frozen-lockfile && pnpm build
```

## VS Code Setup

To use this MCP server with VS Code and GitHub Copilot:

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
            "command": "node",
            // replace 'path/to/project' with your actual project path
            "args": [
                "path/to/project/dist/main.cjs"
            ]
        }
    }
}
```

## Available Tools

### Global Strings Toolkit
- **Find Global Strings `find_global_strings`** - Search for available global strings with content similar to a given query
- **Get Global Strings `get_global_strings_for_keys`** - Retrieve translated string contents for a specific global string key
- **List Global String Keys `list_global_string_keys`** - List all available global string keys for a game client, (useful to give agent context)

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
- **Find Global APIs `find_global_apis`** - Search for global APIs similar to a given API name(s). Supports optional game version filtering
- **Get Global API Wiki Info `get_global_api_wiki_info`** - Fetch the wiki.gg page content for a specific global API name.

Both toolkits support multiple WoW game client flavors:
- `mainline` - Current retail version
- `mists` - Mists of Pandaria Classic
- `vanilla` - Classic WoW

> Note: You may need to specify to the agent to use a specific game flavor
**todo**: add tool/prompt for scanning `.toc` file to determine best client flavor(s)

### Known Issues
 - you may have to try really hard to get your llm to use optional tool parameters correctly. Depends on model.

## Development

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
