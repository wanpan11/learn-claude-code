#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const WORKDIR = process.cwd();
const SYSTEM = `你是一个位于 ${WORKDIR} 的编码代理。
使用 todo 工具来规划多步骤任务。开始前标记为 in_progress，完成后标记为 completed。
优先使用工具而非文本描述。`;

// -- TodoManager: LLM 写入的结构化状态 --
interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const itemId = String(item.id || String(i + 1));

      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }

      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }

      if (status === "in_progress") {
        inProgressCount++;
      }

      validated.push({ id: itemId, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines: string[] = [];
    for (const item of this.items) {
      const marker = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      }[item.status];
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }

    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

// -- 工具实现 --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return Promise.resolve("Error: Dangerous command blocked");
  }

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const shellArgs = process.platform === "win32" ? ["-Command", command] : ["-c", command];
    const child = spawn(shell, shellArgs, { timeout: 120000 });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const output = (stdout + stderr).trim();
      resolve(output ? output.slice(0, 50000) : "(no output)");
    });

    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), "utf-8");
    let lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: any) => Promise<string> | string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  todo: (input) => TODO.update(input.items),
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// -- 带有提醒注入的 Agent 循环 --
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsSinceTodo = 0;

  while (true) {
    /// 提醒机制：如果 5 轮以上没有更新 todo，注入提醒
    if (roundsSinceTodo >= 5 && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === "user" && Array.isArray(last.content)) {
        messages.push({ role: "user", content: [{ type: "text", text: "<reminder>Update your todos.</reminder>" }] });
      }
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log("[ 工具参数 ] ===>", `[${block.name}]`, block.input);

        const handler = TOOL_HANDLERS[block.name];
        let output: string;

        if (!handler) {
          output = `Unknown tool: ${block.name}`;
        } else {
          try {
            output = String(await handler(block.input));
          } catch (error) {
            output = `Error: ${(error as Error).message}`;
          }
        }

        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });

        if (block.name === "todo") {
          usedTodo = true;
        }
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
    try {
      const query = await prompt("\x1b[36ms02 >> \x1b[0m");
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") break;
      console.error("Error:", error);
    }
  }

  rl.close();
}

main().catch(console.error);
