#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import readline from "readline";
import { WORKDIR, runBash, runRead, runWrite, runEdit, TEAM_DIR, INBOX_DIR, VALID_MSG_TYPES, TASKS_DIR, getAiTextContent, logger } from "./common.js";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const POLL_INTERVAL = 5000; // 5 秒（毫秒）
const IDLE_TIMEOUT = 1000 * 60 * 2; // 2 分钟（毫秒）

const SYSTEM = `You are a team lead at {WORKDIR}. Teammates are autonomous -- they find work themselves.`;

// -- 请求跟踪器 --
const shutdownRequests: Map<string, { target: string; status: string }> = new Map();
const planRequests: Map<string, { from: string; plan: string; status: string }> = new Map();
const claimLock = { locked: false };

// -- 类型定义 --
interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
}
interface Task {
  id: number;
  subject: string;
  description?: string;
  status: string;
  owner?: string;
  blockedBy?: number[];
}
interface TeamMember {
  name: string;
  role: string;
  status: string;
}
interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

// -- 消息总线：每个队友一个 JSONL 收件箱 --
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra?: Record<string, any>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `错误：无效的类型 '${msgType}'。有效类型：${Array.from(VALID_MSG_TYPES).join("、")}`;
    }
    const msg: Message = {
      type: msgType,
      from: sender,
      content: content,
      timestamp: Date.now(),
      ...extra,
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `已将 ${msgType} 发送给 ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const content = fs.readFileSync(inboxPath, "utf-8");
    const messages: Message[] = [];
    for (const line of content.trim().split("\n")) {
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `已广播给 ${count} 个队友`;
  }
}
const BUS = new MessageBus(INBOX_DIR);

// -- 任务板扫描 --
function scanUnclaimedTasks(): Task[] {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: Task[] = [];
  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const task: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
    if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}
function claimTask(taskId: number, owner: string): string {
  // 简单的锁机制
  while (claimLock.locked) {
    // 等待
  }
  claimLock.locked = true;
  try {
    const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
    if (!fs.existsSync(taskPath)) {
      return `错误：未找到任务 ${taskId}`;
    }
    const task: Task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
    task.owner = owner;
    task.status = "in_progress";
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
    return `已为 ${owner} 认领任务 #${taskId}`;
  } finally {
    claimLock.locked = false;
  }
}
// -- 压缩后重新注入身份 --
function makeIdentityBlock(name: string, role: string, teamName: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: `<identity>你是 '${name}'，角色：${role}，团队：${teamName}。继续你的工作。</identity>`,
  };
}

// -- 自主队友管理器 --
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, Promise<void>>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this.loadConfig();
    this.threads = new Map();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: string): void {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `错误：'${name}' 当前状态为 ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    const thread = this.loop(name, role, prompt);
    this.threads.set(name, thread);
    return `已创建 '${name}'（角色：${role}）`;
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `你是 '${name}'，角色：${role}，团队：${teamName}，位于 ${WORKDIR}。当你没有更多工作时使用 idle 工具。你将自动认领新任务。`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    while (true) {
      // -- 工作阶段：标准代理循环 --
      for (let i = 0; i < 50; i++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        const response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages: messages,
          tools: tools,
          max_tokens: 8000,
        });
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
          const textContent = getAiTextContent(response);
          logger.info(`[ ${name} 回复 ] ===>`, { content: textContent });
          break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let idleRequested = false;
        for (const block of response.content) {
          if (block.type === "tool_use") {
            logger.info(`[ ${name} 工具调用 ] ===>`, { tool: block.name, input: block.input });

            let output: string;
            if (block.name === "idle") {
              idleRequested = true;
              output = "进入空闲阶段。将轮询新任务。";
            } else {
              output = await this.exec(name, block.name, block.input);
            }
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
          }
        }
        messages.push({ role: "user", content: results });

        if (idleRequested) {
          break;
        }
      }

      // -- 空闲阶段：轮询收件箱消息和未认领的任务 --
      this.setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

      for (let i = 0; i < polls; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

        const inbox = BUS.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          claimTask(task.id, name);
          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;

          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `我是 ${name}。继续工作。` });
          }
          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `已认领任务 #${task.id}。开始处理。` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }
      this.setStatus(name, "working");
    }
  }

  private async exec(sender: string, toolName: string, args: any): Promise<string> {
    if (toolName === "bash") {
      return await runBash(args.command);
    }
    if (toolName === "read_file") {
      return runRead(args.path);
    }
    if (toolName === "write_file") {
      return runWrite(args.path, args.content);
    }
    if (toolName === "edit_file") {
      return runEdit(args.path, args.old_text, args.new_text);
    }
    if (toolName === "send_message") {
      return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      const req = shutdownRequests.get(reqId);
      if (req) {
        req.status = args.approve ? "approved" : "rejected";
      }
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve: args.approve,
      });
      return `关闭请求${args.approve ? "已批准" : "已拒绝"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = Math.random().toString(36).substring(2, 10);
      planRequests.set(reqId, { from: sender, plan: planText, status: "pending" });
      BUS.send(sender, "lead", planText, "plan_approval_response", {
        request_id: reqId,
        plan: planText,
      });
      return `计划已提交（request_id=${reqId}）。等待批准。`;
    }
    if (toolName === "claim_task") {
      return claimTask(args.task_id, sender);
    }
    return `未知工具：${toolName}`;
  }

  private teammateTools(): Anthropic.Tool[] {
    return [
      {
        name: "bash",
        description: "运行 shell 命令。",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "读取文件内容。",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "将内容写入文件。",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "替换文件中的精确文本。",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "发送消息给队友。",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "读取并清空你的收件箱。",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "响应关闭请求。",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "提交计划给负责人审批。",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
      {
        name: "idle",
        description: "表示你没有更多工作。进入空闲轮询阶段。",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "通过 ID 从任务板认领任务。",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
      },
    ];
  }

  listAll(): string {
    if (this.config.members.length === 0) {
      return "没有队友。";
    }
    const lines = [`团队：${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}
const TEAM = new TeammateManager(TEAM_DIR);

// -- 负责人专用协议处理器 --
function handleShutdownRequest(teammate: string): string {
  const reqId = Math.random().toString(36).substring(2, 10);
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send("lead", teammate, "请正常关闭。", "shutdown_request", { request_id: reqId });
  return `关闭请求 ${reqId} 已发送给 '${teammate}'`;
}
function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests.get(requestId);
  if (!req) {
    return `错误：未知的计划 request_id '${requestId}'`;
  }
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve: approve,
    feedback: feedback,
  });
  return `'${req.from}' 的计划${req.status === "approved" ? "已批准" : "已拒绝"}`;
}
function checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  return JSON.stringify(req || { error: "未找到" });
}

// -- 负责人工具分发（14 个工具） --
const TOOL_HANDLERS: Record<string, (args: any) => string | Promise<string>> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  spawn_teammate: (args) => TEAM.spawn(args.name, args.role, args.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
  shutdown_request: (args) => handleShutdownRequest(args.teammate),
  shutdown_response: (args) => checkShutdownStatus(args.request_id || ""),
  plan_approval: (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
  idle: () => "负责人不会空闲。",
  claim_task: (args) => claimTask(args.task_id, "lead"),
};
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "运行 shell 命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "替换文件中的精确文本。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "spawn_teammate",
    description: "创建一个自主队友。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "列出所有队友。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "向队友发送消息。",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "读取并清空负责人的收件箱。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "向所有队友发送消息。",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description: "请求队友关闭。",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "检查关闭请求状态。",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "批准或拒绝队友的计划。",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "进入空闲状态（用于负责人——很少使用）。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "通过 ID 从任务板认领任务。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "已记录收件箱消息。",
      });
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
      const textContent = getAiTextContent(response);
      logger.info(`[ 主 回复 ] ===>`, { content: textContent });
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        logger.info("[ 主 工具调用 ] ===>", { tool: block.name, input: block.input });

        const handler = TOOL_HANDLERS[block.name];
        let output = await handler(block.input);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// -- 主 REPL --
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms11 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query: string) => {
    const trimmed = query.trim();

    if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit" || trimmed === "") {
      rl.close();
      return;
    }

    if (trimmed === "/team") {
      console.log(TEAM.listAll());
      rl.prompt();
      return;
    }

    if (trimmed === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      rl.prompt();
      return;
    }

    if (trimmed === "/tasks") {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      const files = fs
        .readdirSync(TASKS_DIR)
        .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
        .sort();
      for (const file of files) {
        const task: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
        const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[task.status] || "[?]";
        const owner = task.owner ? ` @${task.owner}` : "";
        console.log(`  ${marker} #${task.id}: ${task.subject}${owner}`);
      }
      rl.prompt();
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
