#!/usr/bin/env node

import OpenAI from "openai";
import dotenv from "dotenv";

import * as readline from "readline";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./common";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。使用工具来解决任务。行动，不要解释。`;

// -- 工具调度映射表: {工具名: 处理函数} --
const TOOL_HANDLERS: Record<string, (input: any) => Promise<string> | string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
};

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
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
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
          limit: { type: "number", description: "Max lines to read (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace old_text with new_text in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
];

async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const assistantMessage = response.choices[0].message;

    // 显示回复内容或工具调用信息
    if (assistantMessage.content) {
      console.log("[ 回复 ] ===>", assistantMessage.content);
    }
    if (assistantMessage.tool_calls) {
      console.log(`[ 工具调用 ] ===> ${assistantMessage.tool_calls.length} 个工具`);
    }

    // 添加助手回复
    messages.push(assistantMessage);

    // 如果模型没有调用工具，则完成
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return;
    }

    const toolMessages: OpenAI.ChatCompletionToolMessageParam[] = [];
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const handler = TOOL_HANDLERS[toolCall.function.name];
      if (!handler) {
        toolMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: Unknown tool '${toolCall.function.name}'`,
        });
        continue;
      }

      console.log("[ 工具参数 ] ===>", `[${toolCall.function.name}]`, toolCall.function.arguments);
      const args = JSON.parse(toolCall.function.arguments);

      const output = await handler(args);
      toolMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }
    messages.push(...toolMessages);
  }
}

async function main() {
  const history: OpenAI.ChatCompletionMessageParam[] = [];
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
