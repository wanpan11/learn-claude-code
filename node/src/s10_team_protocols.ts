#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";
import { INBOX_DIR, runBash, runEdit, runRead, runWrite, TEAM_DIR, VALID_MSG_TYPES, WORKDIR } from "./common";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const SYSTEM = `你是 ${WORKDIR} 的团队负责人。使用关闭和计划审批协议管理队友。`;

// -- 请求跟踪器：通过 request_id 关联 --
interface ShutdownRequest {
  target: string;
  status: string;
}
interface PlanRequest {
  from: string;
  plan: string;
  status: string;
}
const shutdownRequests: Map<string, ShutdownRequest> = new Map();
const planRequests: Map<string, PlanRequest> = new Map();

// -- 消息总线：每个队友一个 JSONL 收件箱 --
interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
}
class MessageBus {
  constructor(private dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra?: Record<string, any>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `错误：无效的类型 '${msgType}'。有效类型：${Array.from(VALID_MSG_TYPES).join("、")}`;
    }

    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...extra,
    };

    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf-8");
    return `已将 ${msgType} 发送给 ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }

    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!content) {
      return [];
    }

    const messages = content
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l));
    fs.writeFileSync(inboxPath, "", "utf-8"); // 清空收件箱
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

// -- 队友管理器（带关闭和计划审批功能） --
interface TeamMember {
  name: string;
  role: string;
  status: string;
}
interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private promises: Map<string, Promise<void>>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this._loadConfig();
    this.promises = new Map();
  }

  private _loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  private _findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
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
    this._saveConfig();

    const promise = this._teammateLoop(name, role, prompt);
    this.promises.set(name, promise);
    return `已创建 '${name}'（角色：${role}）`;
  }

  private async _teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt = `你是 '${name}'，角色：${role}，位于 ${WORKDIR}。在重要工作之前通过 plan_approval 提交计划。使用 shutdown_response 响应 shutdown_request。`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      if (shouldExit) {
        break;
      }

      const response = await client.messages.create({
        model: MODEL,
        system: sysPrompt,
        messages,
        tools,
        max_tokens: 8000,
      });
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        console.log(
          `[ ${name} 回复 ] ===>`,
          response.content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n") || "(无文本响应)",
        );
        return;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`[ ${name} 工具调用 ] ===>`, `[${block.name}]`, block.input);
          const output = await this._exec(name, block.name, block.input as Record<string, any>);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });

          if (block.name === "shutdown_response" && (block.input as any).approve) {
            shouldExit = true;
          }
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this._saveConfig();
    }
  }

  private async _exec(sender: string, toolName: string, args: Record<string, any>): Promise<string> {
    if (toolName === "bash") {
      return runBash(args.command);
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
      const approve = args.approve;
      const req = shutdownRequests.get(reqId);
      if (req) {
        req.status = approve ? "approved" : "rejected";
      }
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", { request_id: reqId, approve });
      return `关闭请求${approve ? "已批准" : "已拒绝"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = randomUUID().slice(0, 8);
      planRequests.set(reqId, { from: sender, plan: planText, status: "pending" });
      BUS.send(sender, "lead", planText, "plan_approval_response", { request_id: reqId, plan: planText });
      return `计划已提交（request_id=${reqId}）。等待负责人批准。`;
    }
    return `未知工具：${toolName}`;
  }

  private _teammateTools(): Anthropic.Tool[] {
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
        description: "响应关闭请求。批准以关闭，拒绝以继续工作。",
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
        description: "提交计划给负责人审批。提供计划文本。",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
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
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send("lead", teammate, "请正常关闭。", "shutdown_request", { request_id: reqId });
  return `关闭请求 ${reqId} 已发送给 '${teammate}'（状态：待处理）`;
}
function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests.get(requestId);
  if (!req) {
    return `错误：未知的计划 request_id '${requestId}'`;
  }
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `'${req.from}' 的计划${req.status === "approved" ? "已批准" : "已拒绝"}`;
}
function _checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  if (!req) {
    return JSON.stringify({ error: "未找到" });
  }
  return JSON.stringify(req);
}

// -- 负责人工具分发（12 个工具） --
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
  shutdown_response: (args) => _checkShutdownStatus(args.request_id || ""),
  plan_approval: (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
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
    description: "创建一个持久化队友。",
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
    description: "请求队友正常关闭。返回用于跟踪的 request_id。",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "通过 request_id 检查关闭请求的状态。",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "批准或拒绝队友的计划。提供 request_id + approve + 可选的反馈。",
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
];

// -- 负责人的循环：处理输入、工具调用和收件箱 --
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
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      console.log(
        "[ 主 回复 ] ===>",
        response.content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "(无文本响应)",
      );
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log("[ 主 工具调用 ] ===>", `[${block.name}]`, block.input);

        const handler = TOOL_HANDLERS[block.name];
        let output = await handler(block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
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
    prompt: "\x1b[36ms10 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const query = line.trim();
    if (query.toLowerCase() === "q" || query.toLowerCase() === "exit" || query === "") {
      rl.close();
      process.exit(0);
    }
    if (query === "/team") {
      console.log(TEAM.listAll());
      rl.prompt();
      return;
    }
    if (query === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      rl.prompt();
      return;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}
main().catch(console.error);
