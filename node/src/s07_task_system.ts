#!/usr/bin/env node
/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
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
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
interface Task {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

class TaskManager {
  private nextId: number;

  constructor(private dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    const ids = files.map(f => parseInt(f.replace('task_', '').replace('.json', ''))).filter(n => !isNaN(n));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private load(taskId: number): Task {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  private save(task: Task): void {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
  }

  create(subject: string, description: string = ''): string {
    const task: Task = {
      id: this.nextId++,
      subject,
      description,
      status: 'pending',
      blockedBy: [],
      blocks: [],
      owner: '',
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(taskId);
    
    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task['status'];
      
      if (status === 'completed') {
        this.clearDependency(taskId);
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch (e) {
          // Ignore if task doesn't exist
        }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    for (const file of files) {
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8'));
      if (task.blockedBy?.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id: number) => id !== completedId);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
    if (files.length === 0) {
      return 'No tasks.';
    }

    const tasks: Task[] = files.map(f => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')));
    const lines: string[] = [];
    
    for (const task of tasks) {
      const marker = {
        pending: '[ ]',
        in_progress: '[>]',
        completed: '[x]',
      }[task.status] || '[?]';
      
      const blocked = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
      lines.push(`${marker} #${task.id}: ${task.subject}${blocked}`);
    }

    return lines.join('\n');
  }
}

const TASKS = new TaskManager(TASKS_DIR);

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
  task_create: (input) => TASKS.create(input.subject, input.description || ''),
  task_update: (input) => TASKS.update(input.task_id, input.status, input.addBlockedBy, input.addBlocks),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(input.task_id),
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
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
    name: 'task_create',
    description: 'Create a new task.',
    input_schema: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] },
  },
  {
    name: 'task_update',
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        addBlockedBy: { type: 'array', items: { type: 'integer' } },
        addBlocks: { type: 'array', items: { type: 'integer' } },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_list',
    description: 'List all tasks with status summary.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'task_get',
    description: 'Get full details of a task by ID.',
    input_schema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] },
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
      const query = await prompt('\x1b[36ms07 >> \x1b[0m');
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

export { agentLoop, TaskManager };
