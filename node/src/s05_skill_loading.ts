#!/usr/bin/env node
/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 *     Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 *     Layer 2 (on demand): full skill body in tool_result
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || 'claude-sonnet-4-20250514';
const SKILLS_DIR = path.join(WORKDIR, '.skills');

// -- SkillLoader: parse .skills/*.md files with YAML frontmatter --
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

    const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.md'));
    for (const file of files.sort()) {
      const name = path.basename(file, '.md');
      const text = fs.readFileSync(path.join(this.skillsDir, file), 'utf-8');
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
    for (const line of match[1].trim().split('\n')) {
      const colonPos = line.indexOf(':');
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
      return '(no skills available)';
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || 'No description';
      const tags = skill.meta.tags || '';
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(', ');
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

// -- Tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some(d => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }

  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const child = spawn(shell, [process.platform === 'win32' ? '-Command' : '-c', command], {
      cwd: WORKDIR,
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', () => {
      const output = (stdout + stderr).trim();
      resolve(output ? output.slice(0, 50000) : '(no output)');
    });

    child.on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), 'utf-8');
    let lines = content.split('\n');
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join('\n').slice(0, 50000);
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), 'utf-8');
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
  load_skill: (input) => SKILL_LOADER.getContent(input.name),
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'load_skill',
    description: 'Load specialized knowledge by name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to load' },
      },
      required: ['name'],
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

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = String(handler ? await handler(block.input) : `Unknown tool: ${block.name}`);
        } catch (error) {
          output = `Error: ${(error as Error).message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: 'user', content: results });
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
      const query = await prompt('\x1b[36ms05 >> \x1b[0m');
      if (!query || ['q', 'exit'].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: 'user', content: query });
      await agentLoop(history);
      console.log();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break;
      console.error('Error:', error);
    }
  }

  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agentLoop, SkillLoader };
