#!/usr/bin/env node
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *   Layer 1: micro_compact - replace old tool results with placeholders
 *   Layer 2: auto_compact - save transcript, summarize when tokens > 50000
 *   Layer 3: compact tool - manual compression on demand
 *
 * Key insight: "The agent can forget strategically and keep working forever."
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, '.transcripts');
const KEEP_RECENT = 3;

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

// -- Layer 1: micro_compact - replace old tool results with placeholders --
function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResults: Array<{ msgIdx: number; partIdx: number; result: any }> = [];
  
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (typeof part === 'object' && part.type === 'tool_result') {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  // Build tool name map from assistant messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  // Clear old results (keep last KEEP_RECENT)
  const toClear = toolResults.slice(0, toolResults.length - KEEP_RECENT);
  for (const { result } of toClear) {
    if (typeof result.content === 'string' && result.content.length > 100) {
      const toolId = result.tool_use_id || '';
      const toolName = toolNameMap.get(toolId) || 'unknown';
      result.content = `[Previous: used ${toolName}]`;
    }
  }

  return messages;
}

// -- Layer 2: auto_compact - save transcript, summarize, replace messages --
async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  
  const lines = messages.map(msg => JSON.stringify(msg)).join('\n');
  fs.writeFileSync(transcriptPath, lines, 'utf-8');
  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: 'user',
      content: 'Summarize this conversation for continuity. Include: ' +
        '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
        'Be concise but preserve critical details.\n\n' + conversationText
    }],
    max_tokens: 2000,
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Replace all messages with compressed summary
  return [
    { role: 'user', content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the context from the summary. Continuing.' },
  ];
}

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
  compact: () => 'Manual compression requested.',
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
    name: 'compact',
    description: 'Trigger manual conversation compression.',
    input_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'What to preserve in the summary' },
      },
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    microCompact(messages);

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      console.log('[auto_compact triggered]');
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

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let output: string;
        
        if (block.name === 'compact') {
          manualCompact = true;
          output = 'Compressing...';
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = String(handler ? await handler(block.input) : `Unknown tool: ${block.name}`);
          } catch (error) {
            output = `Error: ${(error as Error).message}`;
          }
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

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log('[manual compact]');
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
      const query = await prompt('\x1b[36ms06 >> \x1b[0m');
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

export { agentLoop, microCompact, autoCompact };
