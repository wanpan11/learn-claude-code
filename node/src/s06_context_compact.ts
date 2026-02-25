#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./common";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const SYSTEM = `你是一个位于 ${WORKDIR} 的编码代理。使用工具来解决任务。`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

// -- 第1层：micro_compact - 用占位符替换旧的工具结果 --
// 对 tool_result 工具输出结果 进行微压缩：如果内容过长且不是最近的几个结果，就替换为简短占位符，保留工具名称以提供上下文线索。
function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResults: Array<{ msgIdx: number; partIdx: number; result: any }> = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (typeof part === "object" && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  // 从助手消息中构建工具名称映射
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && "type" in block && block.type === "tool_use") {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  // 清除旧结果（保留最后 KEEP_RECENT 个）
  const toClear = toolResults.slice(0, toolResults.length - KEEP_RECENT);
  for (const { result } of toClear) {
    if (typeof result.content === "string" && result.content.length > 100) {
      const toolId = result.tool_use_id || "";
      const toolName = toolNameMap.get(toolId) || "unknown";
      result.content = `[Previous: used ${toolName}]`;
    }
  }

  return messages;
}

// -- 第2层：auto_compact - 保存记录、总结并替换消息 --
async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);

  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  fs.writeFileSync(transcriptPath, lines, "utf-8");
  console.log(`[transcript saved: ${transcriptPath}]`);

  // 请求 LLM 进行总结
  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 用压缩后的摘要替换所有消息
  return [
    { role: "user", content: `[对话已压缩。记录位置：${transcriptPath}]\n\n${summary}` },
    { role: "assistant", content: "明白了。我已从摘要中获得上下文。继续执行。" },
  ];
}

const TOOL_HANDLERS: Record<string, (input: any) => Promise<string> | string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  compact: () => "Manual compression requested.",
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
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "What to preserve in the summary" },
      },
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 第1层：每次调用 LLM 前执行 micro_compact
    microCompact(messages);

    // 第2层：如果估算的 token 数超过阈值，执行 auto_compact
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
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
      console.log(
        "[ 回复 ] ===>",
        response.content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "(无文本响应)",
      );
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log("[ 工具调用 ] ===>", `[${block.name}]`, block.input);
        let output: string;

        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = await handler(block.input);
        }

        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    messages.push({ role: "user", content: results });

    // 第3层：由 compact 工具触发的手动压缩
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
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
      const query = await prompt("\x1b[36ms06 >> \x1b[0m");
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
