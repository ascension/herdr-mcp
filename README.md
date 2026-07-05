# herdr-mcp

MCP server that lets AI assistants orchestrate coding agents running in
[Herdr](https://herdr.dev) by wrapping its Unix-socket JSON-RPC API
(`~/.config/herdr/herdr.sock`, newline-delimited JSON, verified against
Herdr 0.7.1 / socket protocol 14).

## Requirements

- A running Herdr server (the socket must exist; check with `herdr agent list`)
- Node.js ≥ 20
- macOS or Linux (the transport is a Unix domain socket)

## Build

```sh
git clone <this-repo> && cd herdr-mcp
npm ci
npm run build     # emits dist/
```

The server binary is then `node /abs/path/to/herdr-mcp/dist/index.js`. All
examples below use that form; substitute your absolute path. To run from
source instead (no build step), use `npx tsx /abs/path/to/herdr-mcp/src/index.ts`.

Set the `HERDR_SOCKET` environment variable if your socket is not at
`~/.config/herdr/herdr.sock`.

## Installation

### Claude Code

```sh
claude mcp add --scope user herdr -- node /abs/path/to/herdr-mcp/dist/index.js
```

(`--scope user` makes it available in every project; omit for project-local.)
Verify with `/mcp` inside a session.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then
restart the app:

```json
{
  "mcpServers": {
    "herdr": {
      "command": "node",
      "args": ["/abs/path/to/herdr-mcp/dist/index.js"]
    }
  }
}
```

### Cursor

Settings → MCP → Add server, or `~/.cursor/mcp.json` (global) /
`.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "herdr": {
      "command": "node",
      "args": ["/abs/path/to/herdr-mcp/dist/index.js"]
    }
  }
}
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json` in a workspace, or run **MCP: Add Server** from the
command palette:

```json
{
  "servers": {
    "herdr": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/herdr-mcp/dist/index.js"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "herdr": {
      "command": "node",
      "args": ["/abs/path/to/herdr-mcp/dist/index.js"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.herdr]
command = "node"
args = ["/abs/path/to/herdr-mcp/dist/index.js"]
```

To pass a non-default socket path in any client, add an `env` block, e.g.
`"env": { "HERDR_SOCKET": "/run/user/1000/herdr.sock" }`.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `list_agents` | read | Agents with live status and the `agent_id` used to target them |
| `get_layout` | read | Full tree: workspaces → tabs → panes with split geometry; every pane marked `agent` (with status) or `shell` |
| `read_pane` | read | Any pane's screen (`visible` / `recent` / `detection` sources) |
| `wait_for_agent_status` | read | Blocks until an agent reaches a status (event-driven, per-pane `events.subscribe`); timeout reported, not thrown |
| `wait_for_output` | read | Blocks until a pane's output matches a substring/regex (`pane.wait_for_output` on a dedicated connection) |
| `send_to_agent` | **acts** | Types into an agent's terminal; explicit `submit` flag controls the newline; validates the target first and returns the pane's screen as evidence |
| `send_keys` | **acts** | Named keys (`enter`, `c-c`, `escape`, …) to any pane, with screen evidence |
| `start_agent` | **acts** | Launches an agent (`agent.start`) in a new pane |
| `edit_layout` | **acts** | split / move / swap / resize / zoom / close_pane; refuses to close agent panes; returns resulting layout |
| `manage_tabs` | **acts** | create / rename / focus / close for tabs and workspaces; refuses to close containers holding agents |
| `manage_worktrees` | **acts** | Herdr's git-worktree integration (list / create / open / remove) |
| `notify_user` | **acts** | Desktop notification via `notification.show` |
| `herdr_rpc` | **acts** | Raw escape hatch to any socket method (full API parity; `server.stop` refused) |

Herdr quirks the client absorbs (0.7.1): the server closes the connection
after every reply, so requests are serialized through a queue with one
transparent retry; `pane.split` / `pane.resize` act on the *focused* pane
(`edit_layout` focuses the target tab and restores focus after); event
subscriptions are per-pane.

## Development

```sh
npm run dev      # run the server on stdio
npm run inspect  # MCP Inspector against the live server
npm run check    # biome lint + tsc + vitest
```

Layout: `src/protocol.ts` (wire types, zod schemas, guards) →
`src/connection.ts` (one NDJSON connection: framing, id correlation, pushes) →
`src/herdr-client.ts` (`HerdrApi` interface + reconnecting client; one
dedicated connection per event subscription) → `src/tools.ts` (MCP tools
against `HerdrApi`) → `src/index.ts` (stdio wiring).

Notes for extenders: Herdr 0.7.1 closes the connection after each reply — the
client transparently retries once on a fresh connection (never for
server-answered errors). Tool output is deliberately shaped
(`src/views.ts`); don't dump raw socket JSON into Claude's context. Tools
depend on the `HerdrApi` interface, so new tools are testable against the
in-memory fake in `test/tools.test.ts`.
