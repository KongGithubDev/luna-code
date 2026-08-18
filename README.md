# LunaCode

Local coding assistant for ChatGPT 5.6 Luna via the Model Context Protocol (MCP).

LunaCode runs an MCP server on your machine that exposes file I/O, code search, terminal execution, and git operations. ChatGPT Luna calls these tools through OpenAI's Secure MCP Tunnel, giving you a Claude Code-like experience inside ChatGPT.

## Capabilities

### File Operations
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line range (offset/limit) |
| `write_file` | Create or overwrite a file (auto-creates parent directories) |
| `edit_file` | Find-and-replace with exact string matching |
| `move_file` | Move or rename files and directories |
| `delete_file` | Delete a file or empty directory |
| `create_directory` | Create a directory with recursive parent creation |
| `get_file_info` | View file metadata (size, dates, permissions) |

### Navigation and Search
| Tool | Description |
|------|-------------|
| `list_directory` | List directory contents (recursive mode available) |
| `search_files` | Regex/literal search across files (ripgrep or grep) |
| `find_files` | Glob-pattern file discovery (`**/*.ts`, `src/**/*.test.js`) |
| `get_project_info` | Read project config files (package.json, tsconfig.json, etc.) |

### Execution
| Tool | Description |
|------|-------------|
| `run_command` | Execute arbitrary shell commands with configurable timeout |

### Git Operations
| Tool | Description |
|------|-------------|
| `git_status` | Show working tree status |
| `git_diff` | Show changes between commits or working tree |
| `git_log` | View commit history |
| `git_commit` | Stage all changes and commit |
| `git_branch` | List, create, or switch branches |

## Architecture

```
ChatGPT Luna  <-->  OpenAI Tunnel  <-->  tunnel-client  <-->  LunaCode MCP Server
  (browser)        (cloud)           (your machine)         (localhost:3456)
```

1. **LunaCode MCP Server** -- HTTP server exposing tools via MCP protocol (Streamable HTTP transport).
2. **tunnel-client** -- OpenAI's daemon that bridges your local server to the OpenAI control plane over an outbound-only connection. No inbound firewall rules required.
3. **ChatGPT Luna** -- Calls your tools directly through the chat interface.

## Prerequisites

- Node.js 18 or later
- An OpenAI account with:
  - A tunnel created in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)
  - A Runtime API key from [API Keys](https://platform.openai.com/settings/organization/api-keys)
  - Tunnels Read + Use permission on your organization
- [tunnel-client](https://github.com/openai/tunnel-client/releases) v0.0.11 or later

## Setup

### 1. Install and build

```bash
git clone <repo-url> luna-code
cd luna-code
npm install
npm run build
```

### 2. Configure

Copy the example environment and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```
CONTROL_PLANE_API_KEY=sk-your-runtime-api-key
MCP_PORT=3456
MCP_WORK_DIR=/path/to/your/project
```

### 3. Start the MCP server

```bash
node dist/http-server.js
```

Verify the server is running:

```bash
curl http://localhost:3456/health
# {"status":"ok","name":"luna-code","version":"1.0.0","workDir":"/path/to/your/project"}
```

### 4. Set up tunnel-client

Download the latest release from [openai/tunnel-client](https://github.com/openai/tunnel-client/releases).

Initialize a profile:

```bash
export CONTROL_PLANE_API_KEY="sk-your-runtime-api-key"

./tunnel-client.exe init \
  --sample sample_mcp_remote_no_auth \
  --profile luna-code \
  --tunnel-id tunnel_YOUR_TUNNEL_ID \
  --mcp-server-url http://localhost:3456/mcp
```

Verify the configuration:

```bash
./tunnel-client.exe doctor --profile luna-code --explain
```

Start the tunnel:

```bash
./tunnel-client.exe run --profile luna-code
```

The admin UI is available at `http://127.0.0.1:8090/ui` while the tunnel is running.

### 5. Connect from ChatGPT

1. Open ChatGPT and navigate to Plugins.
2. Create a new app and select **Tunnel** as the connection type.
3. Choose your tunnel from the list.
4. Click Connect.

The tunnel-client must be running while you create and use the app.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROL_PLANE_API_KEY` | (none) | OpenAI Runtime API key for tunnel-client |
| `MCP_PORT` | `3456` | Port for the MCP HTTP server |
| `MCP_WORK_DIR` | `.` | Root directory for all file operations |

These can be set in `.env` or as environment variables.

## Project Structure

```
luna-code/
  src/
    index.ts          stdio MCP server (for Claude Desktop, Cursor, etc.)
    http-server.ts    HTTP MCP server (for ChatGPT Luna via tunnel)
  dist/               compiled output
  .env                configuration (not committed)
  package.json
  tsconfig.json
  README.md
```

## Security

- File operations are sandboxed to `MCP_WORK_DIR`. Path traversal is blocked.
- Dangerous commands (`rm -rf /`, `mkfs`, fork bombs) are rejected.
- The MCP server binds to localhost. The tunnel-client handles all external connectivity. No inbound ports are opened.

## Extending

To add a new tool, edit `src/http-server.ts` and register it inside `createMcpServer()`:

```typescript
server.tool(
  "my_tool",
  "What this tool does.",
  {
    input: z.string().describe("Description of the input"),
  },
  async ({ input }) => {
    // implementation
    return { content: [{ type: "text" as const, text: "result" }] };
  }
);
```

Then rebuild:

```bash
npm run build
```

## Troubleshooting

**Port already in use:**
Set `MCP_PORT=8888` in `.env` and update the tunnel-client config accordingly.

**tunnel-client fails to start:**
If the health port (default 8090) conflicts, edit the profile at `~/.config/tunnel-client/luna-code.yaml` and change `health.listen_addr`.

**ChatGPT cannot find the tunnel:**
Ensure the tunnel is associated with your ChatGPT workspace, not just a Platform organization. The tunnel-client must be running when you create the app.

**OAuth error during setup:**
Use the `sample_mcp_remote_no_auth` profile. OAuth is not required for local development servers.

**Tools not appearing in ChatGPT:**
Keep the tunnel-client running. Disconnecting stops tool discovery.

## License

MIT
