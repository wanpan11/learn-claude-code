#!/usr/bin/env node

import OpenAI from "openai";
import { spawn } from "child_process";
import dotenv from "dotenv";
import * as readline from "readline";

dotenv.config();
const MODEL = process.env.MODEL_ID || "deepseek-reasoner";
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

const WORKDIR = process.cwd();
const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。使用 bash 解决任务，只执行不解释。`;

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "运行 shell 命令。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
];

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

// -- 核心模式：一个循环调用工具直到模型停止的 while 循环 --
async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const assistantMessage = response.choices[0].message;
    console.log("[ 回复 ] ===>", assistantMessage.content);

    // 添加助手回复
    messages.push(assistantMessage);

    // 如果模型没有调用工具，则完成
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return;
    }

    // 执行每个工具调用，收集结果
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type === "function" && toolCall.function.name === "bash") {
        const args = JSON.parse(toolCall.function.arguments);
        console.log("[ args.command ] ===>", args.command);

        const output = await runBash(args.command);
        console.log("[ toolCall output ] ===>", output.slice(0, 200));

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
        });
      }
    }
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
      const query = await prompt("\x1b[36ms01 >> \x1b[0m");
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
