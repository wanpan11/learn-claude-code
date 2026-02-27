#!/usr/bin/env node

import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";
import { WORKDIR, runBash, runRead, runWrite, runEdit, logger, detectRepoRoot } from "./common.js";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

const REPO_ROOT = detectRepoRoot(WORKDIR);
const SYSTEM = `
You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. 
For parallel or risky changes: create tasks, allocate worktree lanes, 
run commands in those lanes, then choose keep/remove for closeout. 
Use worktree_events when you need lifecycle visibility.
`;

// -- 类型定义 --
interface Event {
  event: string;
  ts: number;
  task: Record<string, any>;
  worktree: Record<string, any>;
  error?: string;
}
interface Task {
  id: number;
  subject: string;
  description: string;
  status: string;
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
}
interface Worktree {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: string;
  created_at: number;
  kept_at?: number;
  removed_at?: number;
}
interface WorktreeIndex {
  worktrees: Worktree[];
}

// -- EventBus: 用于可观测性的仅追加生命周期事件 --
class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "");
    }
  }

  emit(event: string, task: Record<string, any> | null = null, worktree: Record<string, any> | null = null, error: string | null = null): void {
    const payload: Event = {
      event,
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload.error = error;
    }
    fs.appendFileSync(this.path, JSON.stringify(payload) + "\n");
  }

  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(limit || 20, 200));
    const lines = fs
      .readFileSync(this.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const recent = lines.slice(-n);
    const items: any[] = [];
    for (const line of recent) {
      try {
        items.push(JSON.parse(line));
      } catch {
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

// -- TaskManager: 带可选 worktree 绑定的持久化任务板 --
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const ids: number[] = [];
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const file of files) {
      try {
        const id = parseInt(file.split("_")[1].split(".")[0]);
        ids.push(id);
      } catch {
        // 忽略
      }
    }
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private taskPath(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const taskPath = this.taskPath(taskId);
    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this.taskPath(taskId));
  }

  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner: string = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const tasks: Task[] = [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort();
    for (const file of files) {
      tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8")));
    }
    if (tasks.length === 0) {
      return "No tasks.";
    }
    const lines: string[] = [];
    for (const t of tasks) {
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --
class WorktreeManager {
  private repoRoot: string;
  private tasks: TaskManager;
  private events: EventBus;
  private dir: string;
  private indexPath: string;
  public gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    try {
      const result = execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 120000,
      });
      return result.trim() || "(no output)";
    } catch (error: any) {
      const msg = error.stderr?.toString() || error.stdout?.toString() || error.message;
      throw new Error(msg || `git ${args.join(" ")} failed`);
    }
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
  }

  private saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  private find(name: string): Worktree | undefined {
    const idx = this.loadIndex();
    return idx.worktrees.find((wt) => wt.name === name);
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  create(name: string, taskId?: number, baseRef: string = "HEAD"): string {
    this.validateName(name);
    if (this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit("worktree.create.before", taskId !== undefined ? { id: taskId } : null, { name, base_ref: baseRef });

    try {
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      const entry: Worktree = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);

      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit("worktree.create.after", taskId !== undefined ? { id: taskId } : null, { name, path: wtPath, branch, status: "active" });
      return JSON.stringify(entry, null, 2);
    } catch (error: any) {
      this.events.emit("worktree.create.failed", taskId !== undefined ? { id: taskId } : null, { name, base_ref: baseRef }, error.message);
      throw error;
    }
  }

  listAll(): string {
    const idx = this.loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) {
      return "No worktrees in index.";
    }
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id !== undefined ? ` task=${wt.task_id}` : "";
      lines.push(`[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`);
    }
    return lines.join("\n");
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }
    try {
      const result = execSync("git status --short --branch", {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 60000,
      });
      return result.trim() || "Clean worktree";
    } catch (error: any) {
      return error.message;
    }
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }

    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }

    try {
      const result = execSync(command, {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 300000,
      });
      const output = result.trim();
      return output ? output.slice(0, 50000) : "(no output)";
    } catch (error: any) {
      if (error.killed) {
        return "Error: Timeout (300s)";
      }
      return error.message;
    }
  }

  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    this.events.emit("worktree.remove.before", wt.task_id !== undefined ? { id: wt.task_id } : null, { name, path: wt.path });

    try {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(wt.path);
      this.runGit(args);

      if (completeTask && wt.task_id !== undefined) {
        const taskId = wt.task_id;
        const before = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit("task.completed", { id: taskId, subject: before.subject, status: "completed" }, { name });
      }

      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this.saveIndex(idx);

      this.events.emit("worktree.remove.after", wt.task_id !== undefined ? { id: wt.task_id } : null, { name, path: wt.path, status: "removed" });
      return `Removed worktree '${name}'`;
    } catch (error: any) {
      this.events.emit("worktree.remove.failed", wt.task_id !== undefined ? { id: wt.task_id } : null, { name, path: wt.path }, error.message);
      throw error;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    const idx = this.loadIndex();
    let kept: Worktree | null = null;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this.saveIndex(idx);

    this.events.emit("worktree.keep", wt.task_id !== undefined ? { id: wt.task_id } : null, { name, path: wt.path, status: "kept" });
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// -- 工具处理器 --
const TOOL_HANDLERS: Record<string, (args: any) => string | Promise<string>> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  task_create: (args) => TASKS.create(args.subject, args.description || ""),
  task_list: () => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id),
  task_update: (args) => TASKS.update(args.task_id, args.status, args.owner),
  task_bind_worktree: (args) => TASKS.bindWorktree(args.task_id, args.worktree, args.owner || ""),
  worktree_create: (args) => WORKTREES.create(args.name, args.task_id, args.base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (args) => WORKTREES.status(args.name),
  worktree_run: (args) => WORKTREES.run(args.name, args.command),
  worktree_keep: (args) => WORKTREES.keep(args.name),
  worktree_remove: (args) => WORKTREES.remove(args.name, args.force || false, args.complete_task || false),
  worktree_events: (args) => EVENTS.listRecent(args.limit || 20),
};
const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the current workspace (blocking).",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_create",
      description: "Create a new task on the shared task board.",
      parameters: {
        type: "object",
        properties: { subject: { type: "string" }, description: { type: "string" } },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "List all tasks with status, owner, and worktree binding.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "task_get",
      description: "Get task details by ID.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_update",
      description: "Update task status or owner.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          owner: { type: "string" },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_bind_worktree",
      description: "Bind a task to a worktree name.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } },
        required: ["task_id", "worktree"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_create",
      description: "Create a git worktree and optionally bind it to a task.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_list",
      description: "List worktrees tracked in .worktrees/index.json.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_status",
      description: "Show git status for one worktree.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_run",
      description: "Run a shell command in a named worktree directory.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, command: { type: "string" } },
        required: ["name", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_remove",
      description: "Remove a worktree and optionally mark its bound task completed.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_keep",
      description: "Mark a worktree as kept in lifecycle state without removing it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree_events",
      description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" } },
      },
    },
  },
];

// -- 代理循环 --
async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    // 如果模型没有调用工具，则完成
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      logger.info(`[ 主 回复 ] ===> ${assistantMessage.content || "(无内容)"}`);
      return;
    }

    // 执行每个工具调用，收集结果
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type === "function") {
        const args = JSON.parse(toolCall.function.arguments);
        logger.info(`[ 主 工具调用 ] ===> ${toolCall.function.name} ${JSON.stringify(args)}`);

        const handler = TOOL_HANDLERS[toolCall.function.name];
        let output = await handler(args);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
        });
      }
    }
  }
}

// -- 主 REPL --
async function main() {
  if (!WORKTREES.gitAvailable) {
    console.log("注意：不在 git 仓库中。worktree_* 工具将返回错误。");
  }

  const history: OpenAI.ChatCompletionMessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms12 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query: string) => {
    const trimmed = query.trim();

    if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit" || trimmed === "") {
      rl.close();
      return;
    }

    history.push({ role: "user", content: trimmed });
    await agentLoop(history);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n再见！");
    process.exit(0);
  });
}
main().catch(console.error);
