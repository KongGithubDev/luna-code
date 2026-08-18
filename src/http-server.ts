#!/usr/bin/env node

/**
 * LunaCode MCP Server
 *
 * HTTP-based MCP server providing local coding tools for ChatGPT Luna.
 * Tools mirror Claude Code capabilities: file I/O, search, terminal, git.
 */

import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

const WORK_DIR = path.resolve(process.env.MCP_WORK_DIR || process.argv[2] || process.cwd());
const PORT = parseInt(process.env.MCP_PORT || "3456");
const GIT_EXE = process.platform === "win32" ? "git" : "git";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAbsolute(p: string): boolean {
  // Windows: C:\, C:/, D:\, D:/, etc.
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  // Unix/Mac: /home/...
  if (p.startsWith("/")) return true;
  // UNC: \\server\share
  if (p.startsWith("\\\\")) return true;
  return false;
}

async function resolvePath(p: string): Promise<string> {
  // If absolute path, use it directly (no sandbox check)
  if (isAbsolute(p)) {
    return path.resolve(p);
  }
  // Relative path: resolve against WORK_DIR, check traversal
  const resolved = path.resolve(WORK_DIR, p);
  if (!resolved.startsWith(WORK_DIR)) {
    throw new Error(`Path escapes working directory: ${p}`);
  }
  return resolved;
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function run(cmd: string, cwd?: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execAsync(cmd, {
      cwd: cwd || WORK_DIR,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
    };
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(new Error(`Invalid JSON: ${e}`));
      }
    });
    req.on("error", reject);
  });
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "luna-code", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── File Reading ────────────────────────────────────────────────────────

  server.tool(
    "read_file",
    "Read the contents of a file. Returns the full text. Use offset/limit for partial reads.",
    {
      path: z.string().describe("File path (relative or absolute)"),
      offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of lines to read"),
    },
    async ({ path: filePath, offset, limit }) => {
      try {
        const resolved = await resolvePath(filePath);
        const content = await fs.readFile(resolved, "utf-8");
        if (offset !== undefined || limit !== undefined) {
          const lines = content.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = limit ? start + limit : lines.length;
          const slice = lines.slice(start, end);
          const header = offset !== undefined ? `Lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}:\n` : "";
          return { content: [{ type: "text" as const, text: header + slice.join("\n") }] };
        }
        return { content: [{ type: "text" as const, text: content }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── File Writing ────────────────────────────────────────────────────────

  server.tool(
    "write_file",
    "Create or overwrite a file. Parent directories are created automatically.",
    {
      path: z.string().describe("File path (relative or absolute)"),
      content: z.string().describe("Content to write"),
    },
    async ({ path: filePath, content }) => {
      try {
        const resolved = await resolvePath(filePath);
        await ensureDir(resolved);
        await fs.writeFile(resolved, content, "utf-8");
        return { content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${filePath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── File Editing ────────────────────────────────────────────────────────

  server.tool(
    "edit_file",
    "Replace an exact string in a file. The old_string must match exactly including whitespace and indentation.",
    {
      path: z.string().describe("File path (relative or absolute)"),
      old_string: z.string().describe("Exact string to find and replace (must be unique in the file)"),
      new_string: z.string().describe("Replacement string"),
    },
    async ({ path: filePath, old_string, new_string }) => {
      try {
        const resolved = await resolvePath(filePath);
        const content = await fs.readFile(resolved, "utf-8");
        const count = content.split(old_string).length - 1;
        if (count === 0) {
          return { content: [{ type: "text" as const, text: `Error: old_string not found in ${filePath}` }], isError: true };
        }
        if (count > 1) {
          return { content: [{ type: "text" as const, text: `Warning: old_string appears ${count} times. Only the first occurrence was replaced. Consider providing more context for a unique match.` }], isError: false };
        }
        const updated = content.replace(old_string, new_string);
        await fs.writeFile(resolved, updated, "utf-8");
        return { content: [{ type: "text" as const, text: `Edited ${filePath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── File Move / Rename ──────────────────────────────────────────────────

  server.tool(
    "move_file",
    "Move or rename a file or directory.",
    {
      source: z.string().describe("Source path relative to working directory"),
      destination: z.string().describe("Destination path relative to working directory"),
    },
    async ({ source, destination }) => {
      try {
        const src = await resolvePath(source);
        const dest = await resolvePath(destination);
        await ensureDir(dest);
        await fs.rename(src, dest);
        return { content: [{ type: "text" as const, text: `Moved ${source} -> ${destination}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── File Delete ─────────────────────────────────────────────────────────

  server.tool(
    "delete_file",
    "Delete a file or empty directory.",
    {
      path: z.string().describe("Path (relative or absolute)"),
    },
    async ({ path: filePath }) => {
      try {
        const resolved = await resolvePath(filePath);
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          await fs.rmdir(resolved);
        } else {
          await fs.unlink(resolved);
        }
        return { content: [{ type: "text" as const, text: `Deleted ${filePath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Create Directory ────────────────────────────────────────────────────

  server.tool(
    "create_directory",
    "Create a directory and any necessary parent directories.",
    {
      path: z.string().describe("Directory path relative to working directory"),
    },
    async ({ path: dirPath }) => {
      try {
        const resolved = await resolvePath(dirPath);
        await fs.mkdir(resolved, { recursive: true });
        return { content: [{ type: "text" as const, text: `Created directory ${dirPath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── List Directory ──────────────────────────────────────────────────────

  server.tool(
    "list_directory",
    "List files and subdirectories. Returns a sorted listing.",
    {
      path: z.string().optional().describe("Directory path (absolute or relative, default: working directory)"),
      recursive: z.boolean().optional().describe("List recursively (skips .git and node_modules)"),
    },
    async ({ path: dirPath, recursive }) => {
      try {
        const resolved = await resolvePath(dirPath || ".");
        const ignore = new Set([".git", "node_modules", ".next", "dist", "__pycache__", ".cache"]);

        if (recursive) {
          const entries: string[] = [];
          async function walk(dir: string, prefix: string) {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              if (ignore.has(item.name)) continue;
              const rel = path.join(prefix, item.name).replace(/\\/g, "/");
              entries.push(item.isDirectory() ? `${rel}/` : rel);
              if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
            }
          }
          await walk(resolved, "");
          return { content: [{ type: "text" as const, text: entries.join("\n") || "Empty directory" }] };
        }

        const items = await fs.readdir(resolved, { withFileTypes: true });
        const result = items
          .filter((i) => !ignore.has(i.name))
          .map((i) => (i.isDirectory() ? `${i.name}/` : i.name))
          .sort((a, b) => a.localeCompare(b));
        return { content: [{ type: "text" as const, text: result.join("\n") || "Empty directory" }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── File Info ───────────────────────────────────────────────────────────

  server.tool(
    "get_file_info",
    "Get metadata about a file or directory: type, size, dates, permissions.",
    {
      path: z.string().describe("Path (relative or absolute)"),
    },
    async ({ path: filePath }) => {
      try {
        const resolved = await resolvePath(filePath);
        const stat = await fs.stat(resolved);
        const info = {
          path: filePath,
          type: stat.isDirectory() ? "directory" : "file",
          size: formatBytes(stat.size),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          permissions: (stat.mode & 0o777).toString(8),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );  // ── Search (grep) ───────────────────────────────────────────────────────

  server.tool(
    "search_files",
    "Search for a regex or literal pattern across files. Returns matching lines with file paths and line numbers.",
    {
      pattern: z.string().describe("Search pattern (regex supported)"),
      path: z.string().optional().describe("Directory or file to search in (absolute or relative, default: working directory)"),
      file_type: z.string().optional().describe("Restrict to file extension, e.g. ts, py, js"),
      case_insensitive: z.boolean().optional().describe("Case-insensitive matching"),
      max_results: z.number().optional().describe("Max results to return (default: 50)"),
    },
    async ({ pattern, path: searchPath, file_type, case_insensitive, max_results }) => {
      try {
        const resolved = await resolvePath(searchPath || ".");
        const limit = max_results || 50;
        const regex = new RegExp(pattern, case_insensitive ? "i" : "");
        const skipDirs = new Set([".git", "node_modules", ".next", "dist", "__pycache__", ".cache"]);
        const results: string[] = [];

        async function searchDir(dir: string) {
          if (results.length >= limit) return;
          let items;
          try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const item of items) {
            if (results.length >= limit) return;
            if (item.isDirectory()) {
              if (skipDirs.has(item.name)) continue;
              await searchDir(path.join(dir, item.name));
            } else {
              if (file_type && !item.name.endsWith(`.${file_type}`)) continue;
              const filePath = path.join(dir, item.name);
              try {
                const content = await fs.readFile(filePath, "utf-8");
                const fileLines = content.split("\n");
                for (let i = 0; i < fileLines.length; i++) {
                  if (results.length >= limit) break;
                  if (regex.test(fileLines[i])) {
                    const relPath = path.relative(WORK_DIR, filePath).replace(/\\/g, "/");
                    results.push(`${relPath}:${i + 1}: ${fileLines[i].trim()}`);
                  }
                }
              } catch {}
            }
          }
        }

        await searchDir(resolved);
        const truncated = results.length >= limit ? `\n... (showing ${limit} results, use max_results for more)` : "";
        return { content: [{ type: "text" as const, text: results.join("\n") + truncated || "No matches found." }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Find Files (glob) ───────────────────────────────────────────────────

  server.tool(
    "find_files",
    "Find files by name pattern. Use ** for recursive, * for wildcard. Example: **/*.ts",
    {
      pattern: z.string().describe("Glob pattern, e.g. **/*.ts, src/**/*.test.js, *.json"),
      path: z.string().optional().describe("Base directory (absolute or relative, default: working directory)"),
    },
    async ({ pattern, path: basePath }) => {
      try {
        const resolved = await resolvePath(basePath || ".");
        const skipDirs = new Set([".git", "node_modules", ".next", "dist", "__pycache__", ".cache"]);
        const files: string[] = [];

        // Convert glob pattern to regex
        const regexStr = pattern
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, "{{GLOBSTAR}}")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\{([^}]+)\}/g, (_, opts) => `(${opts.split(",").join("|")})`)
          .replace(/\{\{GLOBSTAR\}\}/g, ".*");
        const regex = new RegExp(`^${regexStr}$`);

        async function findInDir(dir: string) {
          if (files.length >= 100) return;
          let items;
          try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const item of items) {
            if (files.length >= 100) return;
            if (item.isDirectory()) {
              if (skipDirs.has(item.name)) continue;
              await findInDir(path.join(dir, item.name));
            } else if (regex.test(item.name)) {
              const full = path.join(dir, item.name);
              const rel = path.relative(resolved, full).replace(/\\/g, "/");
              files.push(rel);
            }
          }
        }

        await findInDir(resolved);
        return { content: [{ type: "text" as const, text: files.join("\n") || "No files found." }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── Run Command ─────────────────────────────────────────────────────────

  server.tool(
    "run_command",
    "Execute a shell command. Returns stdout and stderr. Use for build, test, npm, git, etc.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory (absolute or relative, default: server working directory)"),
      timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
    },
    async ({ command, cwd, timeout }) => {
      try {
        let workingDir = WORK_DIR;
        if (cwd) {
          workingDir = isAbsolute(cwd) ? path.resolve(cwd) : await resolvePath(cwd);
        }
        const timeoutMs = (timeout || 30) * 1000;

        const blocked = ["rm -rf /", "mkfs", ":(){ :|:& };:"];
        for (const b of blocked) {
          if (command.includes(b)) {
            return { content: [{ type: "text" as const, text: `Blocked dangerous command: ${b}` }], isError: true };
          }
        }

        const { stdout, stderr } = await execAsync(command, {
          cwd: workingDir,
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutMs,
          env: { ...process.env, FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
        });

        let result = "";
        if (stdout) result += stdout;
        if (stderr) result += (result ? "\n--- STDERR ---\n" : "") + stderr;
        if (!result) result = "(command completed with no output)";
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err: any) {
        let result = "";
        if (err.stdout) result += err.stdout;
        if (err.stderr) result += (result ? "\n--- STDERR ---\n" : "") + err.stderr;
        if (err.killed) result += "\nCommand timed out";
        if (!result) result = `Error: ${err.message}`;
        return { content: [{ type: "text" as const, text: result }], isError: true };
      }
    }
  );

  // ── Git: Status ─────────────────────────────────────────────────────────

  server.tool(
    "git_status",
    "Show the working tree status (git status).",
    {},
    async () => {
      const { stdout, stderr } = await run(`${GIT_EXE} status`);
      return { content: [{ type: "text" as const, text: stdout || stderr }] };
    }
  );

  // ── Git: Diff ───────────────────────────────────────────────────────────

  server.tool(
    "git_diff",
    "Show changes between commits, working tree, etc. (git diff).",
    {
      args: z.string().optional().describe("Additional git diff arguments, e.g. HEAD~3, --stat, --staged"),
    },
    async ({ args }) => {
      const { stdout, stderr } = await run(`${GIT_EXE} diff ${args || ""}`);
      return { content: [{ type: "text" as const, text: stdout || stderr || "No changes." }] };
    }
  );

  // ── Git: Log ────────────────────────────────────────────────────────────

  server.tool(
    "git_log",
    "Show commit log history (git log).",
    {
      count: z.number().optional().describe("Number of commits to show (default: 10)"),
      oneline: z.boolean().optional().describe("Show one line per commit (default: true)"),
    },
    async ({ count, oneline }) => {
      const n = count || 10;
      const flag = oneline !== false ? "--oneline" : "";
      const { stdout, stderr } = await run(`${GIT_EXE} log ${flag} -${n}`);
      return { content: [{ type: "text" as const, text: stdout || stderr || "No commits." }] };
    }
  );

  // ── Git: Commit ─────────────────────────────────────────────────────────

  server.tool(
    "git_commit",
    "Stage all changes and create a git commit.",
    {
      message: z.string().describe("Commit message"),
    },
    async ({ message }) => {
      const add = await run(`${GIT_EXE} add -A`);
      const { stdout, stderr } = await run(`${GIT_EXE} commit -m "${message.replace(/"/g, '\\"')}"`);
      return { content: [{ type: "text" as const, text: stdout || stderr }] };
    }
  );

  // ── Git: Branch ─────────────────────────────────────────────────────────

  server.tool(
    "git_branch",
    "List, create, or switch git branches.",
    {
      name: z.string().optional().describe("Branch name to create or switch to (omit to list branches)"),
      checkout: z.boolean().optional().describe("Switch to the branch after creating (default: true)"),
    },
    async ({ name, checkout }) => {
      if (!name) {
        const { stdout } = await run(`${GIT_EXE} branch -a`);
        return { content: [{ type: "text" as const, text: stdout || "No branches." }] };
      }
      const shouldCheckout = checkout !== false;
      const create = await run(`${GIT_EXE} branch ${name}`);
      if (shouldCheckout) {
        const sw = await run(`${GIT_EXE} checkout ${name}`);
        return { content: [{ type: "text" as const, text: sw.stdout || sw.stderr || `Created and switched to ${name}` }] };
      }
      return { content: [{ type: "text" as const, text: create.stdout || create.stderr || `Created branch ${name}` }] };
    }
  );

  // ── Package Info ────────────────────────────────────────────────────────

  server.tool(
    "get_project_info",
    "Read package.json or similar config to understand the project structure and dependencies.",
    {},
    async () => {
      const info: Record<string, any> = {};
      for (const file of ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile"]) {
        try {
          const resolved = await resolvePath(file);
          const content = await fs.readFile(resolved, "utf-8");
          info[file] = file.endsWith(".json") ? JSON.parse(content) : content.substring(0, 2000);
        } catch {}
      }
      if (Object.keys(info).length === 0) {
        return { content: [{ type: "text" as const, text: "No project config files found (package.json, tsconfig.json, etc.)" }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
    }
  );

  return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const transports: Record<string, StreamableHTTPServerTransport> = {};

function setCORS(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Last-Event-ID, Mcp-Session-Id");
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "luna-code", version: "1.0.0", workDir: WORK_DIR }));
    return;
  }

  if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
    try {
      if (req.method === "POST") {
        const parsedBody = await readBody(req);

        if (isInitializeRequest(parsedBody)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) delete transports[sid];
          };

          const mcpServer = createMcpServer();
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
        } else {
          const sessionId = req.headers["mcp-session-id"] as string;
          if (!sessionId || !transports[sessionId]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32600, message: "No valid session. Send an initialize request first." },
              id: null,
            }));
            return;
          }
          await transports[sessionId].handleRequest(req, res, parsedBody);
        }
      } else if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400);
          res.end("Invalid or missing session ID");
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400);
          res.end("Invalid or missing session ID");
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405);
        res.end("Method Not Allowed");
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", endpoints: ["/health", "/mcp"] }));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`LunaCode MCP Server`);
  console.log(`  Endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Work Dir:  ${WORK_DIR}`);
  console.log(`  Ready.`);
});

process.on("SIGINT", async () => {
  for (const sid in transports) {
    try { await transports[sid].close(); delete transports[sid]; } catch {}
  }
  httpServer.close();
  process.exit(0);
});
