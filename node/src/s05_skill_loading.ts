#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
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

const SKILLS_DIR = path.join(WORKDIR, "../skills");

// -- SkillLoader: 解析带有 YAML 前置元数据的 .skills/*.md 文件 --
interface SkillMeta {
  [key: string]: string;
}
interface Skill {
  meta: SkillMeta;
  body: string;
  path: string;
}
class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(private skillsDir: string) {
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const files: string[] = [];
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entry.name);
      } else if (entry.isDirectory()) {
        const subDir = path.join(this.skillsDir, entry.name);
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (subEntry.isFile() && subEntry.name.endsWith(".md")) {
            files.push(path.join(entry.name, subEntry.name));
          }
        }
      }
    }

    for (const file of files.sort()) {
      const name = file.replace(/\.md$/, '').replace(/\\/g, '/');
      const text = fs.readFileSync(path.join(this.skillsDir, file), "utf-8");
      const [meta, body] = this.parseFrontmatter(text);
      this.skills.set(name, { meta, body, path: file });
    }
  }

  private parseFrontmatter(text: string): [SkillMeta, string] {
    const match = /^---\n(.*?)\n---\n(.*)/s.exec(text);
    if (!match) {
      return [{}, text];
    }

    const meta: SkillMeta = {};
    for (const line of match[1].trim().split("\n")) {
      const colonPos = line.indexOf(":");
      if (colonPos > 0) {
        const key = line.slice(0, colonPos).trim();
        const val = line.slice(colonPos + 1).trim();
        meta[key] = val;
      }
    }

    return [meta, match[2].trim()];
  }

  getDescriptions(): string {
    if (this.skills.size === 0) {
      return "(无可用技能)";
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || "无描述";
      const tags = skill.meta.tags || "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(", ");
      return `错误: 未知技能 '${name}'。可用技能: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。
在处理不熟悉的主题之前，使用 load_skill 访问专业知识。

可用技能:
${SKILL_LOADER.getDescriptions()}`;

// -- 工具实现 --
const TOOL_HANDLERS: Record<string, (input: any) => Promise<string> | string> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  load_skill: (input) => SKILL_LOADER.getContent(input.name),
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
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
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
    description: "替换文件中的精确文本。",
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
    name: "load_skill",
    description: "按名称加载专业知识。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要加载的技能名称" },
      },
      required: ["name"],
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
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
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log("[ 工具调用 ] ===>", `[${block.name}]`, block.input);

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
      const query = await prompt("\x1b[36ms05 >> \x1b[0m");
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
