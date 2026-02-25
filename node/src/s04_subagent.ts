#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import * as readline from "readline";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./common";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。使用 task 工具来委托探索或子任务。`;
const SUBAGENT_SYSTEM = `你是位于 ${WORKDIR} 的编码子代理。完成给定的任务，然后总结你的发现。`;

// -- 父代理和子代理共享的工具实现 --
const TOOL_HANDLERS: Record<string, (input: any) => Promise<string> | string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
};

// 子代理获取除 task 之外的所有基础工具（不允许递归生成）
const CHILD_TOOLS: Anthropic.Tool[] = [
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
];

// -- 子代理：全新上下文，过滤的工具，仅返回摘要 --
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages,
      tools: CHILD_TOOLS,
      max_tokens: 8000,
    });

    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // 只有最终文本返回给父代理 -- 子代理的上下文被丢弃
      return (
        response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("") || "(no summary)"
      );
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = String(handler ? await handler(block.input) : `Unknown tool: ${block.name}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output.slice(0, 50000),
        });
      }
    }
    subMessages.push({ role: "user", content: results });
  }

  return "(subagent loop limit reached)";
}

// -- 父代理工具：基础工具 + 任务分发器 --
const PARENT_TOOLS: Anthropic.Tool[] = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: PARENT_TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;

        if (block.name === "task") {
          const input = block.input as { prompt: string; description?: string };
          const desc = input.description || "subtask";
          console.log(`> 子任务 (${desc}): ${input.prompt.slice(0, 120)}...`);
          output = await runSubagent(input.prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = String(handler ? await handler(block.input) : `Unknown tool: ${block.name}`);
        }

        console.log("[ 工具/子任务输出 ] ===>", `  ${output.slice(0, 200)}`);
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
      const query = await prompt("\x1b[36ms04 >> \x1b[0m");
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
