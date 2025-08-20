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

```json
{
    "servers" : {
        // ...
        "wow-dev-mcp": {
            "type": "stdio",
            "command": "node",
            // replace 'path/to/project' with your actual project path
            "args": [
                "path/to/project/src/dist/main.cjs"
            ]
        }
    }
}
```

## Available Tools

### Global Strings Toolkit
Currently, this is the only tool the MCP server provides. It includes:

- **Find Global Strings** - Search for global string keys with content similar to a query
- **Get Global String Contents** - Retrieve translated string contents for a specific global string key
- **List Global String Keys** - List all available global string keys for a game client

The toolkit supports multiple WoW game flavors:
- `mainline` - Current retail version
- `mists` - Mists of Pandaria Classic
- `vanilla` - Classic WoW

and WoW game client locales:

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
