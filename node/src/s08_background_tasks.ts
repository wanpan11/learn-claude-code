#!/usr/bin/env node
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: threaded execution + notification queue --
interface BackgroundTask {
  status: 'running' | 'completed' | 'timeout' | 'error';
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

class BackgroundManager {
  private tasks = new Map<string, BackgroundTask>();
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    const taskId = crypto.randomBytes(4).toString('hex');
    this.tasks.set(taskId, { status: 'running', result: null, command });

    // Execute in background
    this.execute(taskId, command);
    
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private async execute(taskId: string, command: string): Promise<void> {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const child = spawn(shell, [process.platform === 'win32' ? '-Command' : '-c', command], {
      cwd: WORKDIR,
      timeout: 300000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => stdout += data.toString());
    child.stderr?.on('data', (data) => stderr += data.toString());

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('close', () => resolve());
        child.on('error', reject);
      });

      const output = (stdout + stderr).trim();
      const task = this.tasks.get(taskId)!;
      task.status = 'completed';
      task.result = output ? output.slice(0, 50000) : '(no output)';

      this.notificationQueue.push({
        task_id: taskId,
        status: 'completed',
        command: command.slice(0, 80),
        result: (output || '(no output)').slice(0, 500),
      });
    } catch (error) {
      const task = this.tasks.get(taskId)!;
      task.status = 'error';
      task.result = `Error: ${(error as Error).message}`;

      this.notificationQueue.push({
        task_id: taskId,
        status: 'error',
        command: command.slice(0, 80),
        result: `Error: ${(error as Error).message}`.slice(0, 500),
      });
    }
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result || '(running)'}`;
    }

    const lines: string[] = [];
    for (const [tid, task] of this.tasks) {
      lines.push(`${tid}: [${task.status}] ${task.command.slice(0, 60)}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'No background tasks.';
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

const BG = new BackgroundManager();

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

    child.stdout?.on('data', (data) => stdout += data.toString());
    child.stderr?.on('data', (data) => stderr += data.toString());
    child.on('close', () => {
      const output = (stdout + stderr).trim();
      resolve(output ? output.slice(0, 50000) : '(no output)');
    });
    child.on('error', (err) => resolve(`Error: ${err.message}`));
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
  background_run: (input) => BG.run(input.command),
  check_background: (input) => BG.check(input.task_id),
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command (blocking).',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'background_run',
    description: 'Run command in background thread. Returns task_id immediately.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'check_background',
    description: 'Check background task status. Omit task_id to list all.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } } },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Drain background notifications and inject as system message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
      messages.push({ role: 'user', content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: 'assistant', content: 'Noted background results.' });
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return;

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
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: 'user', content: results });
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
    try {
      const query = await prompt('\x1b[36ms08 >> \x1b[0m');
      if (!query || ['q', 'exit'].includes(query.trim().toLowerCase())) break;
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

export { agentLoop, BackgroundManager };
