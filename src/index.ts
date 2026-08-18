#!/usr/bin/env node

/**
 * ChatGPT Coder MCP Server
 * 
 * An MCP server that provides local coding capabilities similar to Claude Code.
 * Designed to work with ChatGPT 5.6 Luna Chat's custom MCP plugin.
 * 
 * Tools provided:
 * - read_file: Read file contents
 * - write_file: Create or overwrite files
 * - edit_file: Edit specific lines in files
 * - list_directory: List directory contents
 * - search_files: Search for patterns in files (grep)
 * - find_files: Find files by name pattern (glob)
 * - run_command: Execute shell commands
 * - get_file_info: Get file metadata
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { glob } from "fs/promises";

const execAsync = promisify(exec);

// Resolve working directory from args or env
const WORK_DIR = process.env.MCP_WORK_DIR || process.argv[2] || process.cwd();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolvePath(p: string): Promise<string> {
  const resolved = path.resolve(WORK_DIR, p);
  // Basic path traversal guard
  if (!resolved.startsWith(WORK_DIR)) {
    throw new Error(`Access denied: path escapes working directory (${WORK_DIR})`);
  }
  return resolved;
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "chatgpt-coder-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// ─── Tools ───────────────────────────────────────────────────────────────────

// 1. READ FILE
server.tool(
  "read_file",
  "Read the contents of a file. Returns the full text content.",
  {
    path: z.string().describe("File path relative to working directory"),
    offset: z.number().optional().describe("Line number to start from (1-indexed)"),
    limit: z.number().optional().describe("Max number of lines to read"),
  },
  async ({ path: filePath, offset, limit }) => {
    try {
      const resolved = await resolvePath(filePath);
      const content = await fs.readFile(resolved, "utf-8");

      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        const end = limit ? start + limit : lines.length;
        const sliced = lines.slice(start, end);
        return {
          content: [{ type: "text" as const, text: sliced.join("\n") }],
        };
      }

      return {
        content: [{ type: "text" as const, text: content }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error reading file: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// 2. WRITE FILE
server.tool(
  "write_file",
  "Create or overwrite a file with the given content. Creates parent directories automatically.",
  {
    path: z.string().describe("File path relative to working directory"),
    content: z.string().describe("Content to write to the file"),
  },
  async ({ path: filePath, content }) => {
    try {
      const resolved = await resolvePath(filePath);
      await ensureDir(resolved);
      await fs.writeFile(resolved, content, "utf-8");
      return {
        content: [{ type: "text" as const, text: `File written successfully: ${filePath}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error writing file: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// 3. EDIT FILE
server.tool(
  "edit_file",
  "Replace exact string matches in a file. Use for precise edits.",
  {
    path: z.string().describe("File path relative to working directory"),
    old_string: z.string().describe("Exact string to find and replace"),
    new_string: z.string().describe("Replacement string"),
  },
  async ({ path: filePath, old_string, new_string }) => {
    try {
      const resolved = await resolvePath(filePath);
      let content = await fs.readFile(resolved, "utf-8");

      if (!content.includes(old_string)) {
        return {
          content: [{ type: "text" as const, text: `Error: old_string not found in ${filePath}` }],
          isError: true,
        };
      }

      content = content.replace(old_string, new_string);
      await fs.writeFile(resolved, content, "utf-8");

      return {
        content: [{ type: "text" as const, text: `File edited successfully: ${filePath}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error editing file: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// 4. LIST DIRECTORY
server.tool(
  "list_directory",
  "List files and subdirectories in a directory.",
  {
    path: z.string().optional().describe("Directory path (default: working directory)"),
    recursive: z.boolean().optional().describe("List recursively"),
  },
  async ({ path: dirPath, recursive }) => {
    try {
      const resolved = await resolvePath(dirPath || ".");

      if (recursive) {
        const entries: string[] = [];
        async function walk(dir: string, prefix: string) {
          const items = await fs.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const rel = path.join(prefix, item.name);
            entries.push(item.isDirectory() ? `${rel}/` : rel);
            if (item.isDirectory()) {
              await walk(path.join(dir, item.name), rel);
            }
          }
        }
        await walk(resolved, "");
        return {
          content: [{ type: "text" as const, text: entries.join("\n") }],
        };
      }

      const items = await fs.readdir(resolved, { withFileTypes: true });
      const result = items
        .map((item) => (item.isDirectory() ? `${item.name}/` : item.name))
        .sort((a, b) => a.localeCompare(b));

      return {
        content: [{ type: "text" as const, text: result.join("\n") }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error listing directory: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// 5. SEARCH FILES (grep-like)
server.tool(
  "search_files",
  "Search for a pattern in files using ripgrep/grep. Returns matching lines with file paths and line numbers.",
  {
    pattern: z.string().describe("Search pattern (regex or literal string)"),
    path: z.string().optional().describe("Directory or file to search in (default: working directory)"),
    file_type: z.string().optional().describe("Filter by file extension (e.g. ts, py, js)"),
    case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
  },
  async ({ pattern, path: searchPath, file_type, case_insensitive }) => {
    try {
      const resolved = await resolvePath(searchPath || ".");
      const args = ["-rn", "--no-binary", "--color=never"];

      if (case_insensitive) args.push("-i");
      if (file_type) args.push(`-g *.${file_type}`);

      args.push(pattern, resolved);

      try {
        const { stdout } = await execAsync(`rg ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
          maxBuffer: 1024 * 1024 * 5,
          timeout: 30000,
        });
        return {
          content: [{ type: "text" as const, text: stdout || "No matches found." }],
        };
      } catch {
        // rg not found, fall back to grep
        const grepArgs = ["-rn"];
        if (case_insensitive) grepArgs.push("-i");
        grepArgs.push(pattern, resolved);

        const { stdout } = await execAsync(`grep ${grepArgs.join(" ")}`, {
          maxBuffer: 1024 * 1024 * 5,
          timeout: 30000,
        });
        return {
          content: [{ type: "text" as const, text: stdout || "No matches found." }],
        };
      }
    } catch (err: any) {
      if (err.stdout) {
        return {
          content: [{ type: "text" as const, text: err.stdout || "No matches found." }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error searching files: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// 6. FIND FILES (glob-like)
server.tool(
  "find_files",
  "Find files by name pattern using glob. Supports **, *, ?, [abc] patterns.",
  {
    pattern: z.string().describe("Glob pattern (e.g. **/*.ts, src/**/*.test.js)"),
    path: z.string().optional().describe("Base directory (default: working directory)"),
  },
  async ({ pattern, path: basePath }) => {
    try {
      const resolved = await resolvePath(basePath || ".");
      const fullPattern = path.join(resolved, pattern);
      const entries: string[] = [];

      // Simple recursive implementation
      async function walk(dir: string, currentPattern: string) {
        try {
          const items = await fs.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            const rel = path.relative(resolved, fullPath);

            if (item.isDirectory() && !item.name.startsWith(".")) {
              await walk(fullPath, currentPattern);
            } else if (item.isFile()) {
              // Simple pattern matching
              const ext = path.extname(item.name);
              const name = item.name;
              
              // Check common patterns
              if (
                currentPattern === "*" ||
                currentPattern === `*${ext}` ||
                (currentPattern.includes("**") && currentPattern.endsWith(ext)) ||
                name.includes(currentPattern.replace("**/", "").replace("*", "")) ||
                matchGlob(name, currentPattern)
              ) {
                entries.push(rel);
              }
            }
          }
        } catch {}
      }

      await walk(resolved, pattern);

      return {
        content: [{ type: "text" as const, text: entries.length > 0 ? entries.join("\n") : "No files found." }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error finding files: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Simple glob matcher
function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
    pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\{\{GLOBSTAR\}\}/g, ".*") +
    "$"
  );
  return regex.test(name);
}

// 7. RUN COMMAND
server.tool(
  "run_command",
  "Execute a shell command. Returns stdout and stderr. Use for running build tools, package managers, git, etc.",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory (default: server working dir)"),
    timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
  },
  async ({ command, cwd, timeout }) => {
    try {
      const workingDir = cwd ? await resolvePath(cwd) : WORK_DIR;
      const timeoutMs = (timeout || 30) * 1000;

      // Safety: block dangerous commands
      const blocked = ["rm -rf /", "mkfs", ":(){ :|:& };:"];
      for (const b of blocked) {
        if (command.includes(b)) {
          return {
            content: [{ type: "text" as const, text: `Blocked dangerous command: ${b}` }],
            isError: true,
          };
        }
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        maxBuffer: 1024 * 1024 * 10,
        timeout: timeoutMs,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let result = "";
      if (stdout) result += `STDOUT:\n${stdout}\n`;
      if (stderr) result += `STDERR:\n${stderr}\n`;
      if (!stdout && !stderr) result = "(command completed with no output)";

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err: any) {
      let result = "";
      if (err.stdout) result += `STDOUT:\n${err.stdout}\n`;
      if (err.stderr) result += `STDERR:\n${err.stderr}\n`;
      if (err.killed) result += `\nCommand timed out`;
      if (!result) result = `Error: ${err.message}`;

      return {
        content: [{ type: "text" as const, text: result }],
        isError: true,
      };
    }
  }
);

// 8. GET FILE INFO
server.tool(
  "get_file_info",
  "Get metadata about a file: size, modified date, permissions, type.",
  {
    path: z.string().describe("File path relative to working directory"),
  },
  async ({ path: filePath }) => {
    try {
      const resolved = await resolvePath(filePath);
      const stat = await fs.stat(resolved);

      const info = {
        path: filePath,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        sizeHuman: formatBytes(stat.size),
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        permissions: (stat.mode & 0o777).toString(8),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  console.error(`[chatgpt-coder-mcp] Starting server...`);
  console.error(`[chatgpt-coder-mcp] Working directory: ${WORK_DIR}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[chatgpt-coder-mcp] Server connected via stdio.`);
}

main().catch((err) => {
  console.error(`[chatgpt-coder-mcp] Fatal error:`, err);
  process.exit(1);
});
