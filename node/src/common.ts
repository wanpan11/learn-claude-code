import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import winston from "winston";

export function getAiTextContent(response: Anthropic.Messages.Message): string {
  return (
    response.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "(无文本响应)"
  );
}

// ========================================= 日志 ============================================ //
// 清空日志文件
const logFile = "team-protocols.log";
if (fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, "", "utf-8");
}
// 自定义格式化器：为"主"相关日志添加黄色，其他日志使用绿色
const customColorFormat = winston.format((info) => {
  // 检查消息中是否包含"主"
  if (info.message && typeof info.message === "string" && info.message.includes("主")) {
    info.message = `\x1b[33m${info.message}\x1b[0m`;
  } else {
    info.message = `\x1b[32m${info.message}\x1b[0m`;
  }
  return info;
});
// 配置 winston logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customColorFormat(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
      return `${timestamp} [${level}] ${message} ${metaStr}`;
    }),
  ),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: logFile })],
});

// ========================================= tools ============================================ //
export const WORKDIR = process.cwd();

export function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return Promise.resolve("错误：危险命令已被阻止");
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
      resolve(output ? output.slice(0, 50000) : "(无输出)");
    });

    child.on("error", (err) => {
      resolve(`错误：${err.message}`);
    });
  });
}

export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`路径超出工作区：${p}`);
  }
  return resolved;
}

export function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), "utf-8");
    let lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (还有 ${lines.length - limit} 行)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error) {
    return `错误：${(error as Error).message}`;
  }
}

export function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `写入 ${content.length} 字节到 ${filePath}`;
  } catch (error) {
    return `错误：${(error as Error).message}`;
  }
}

export function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `错误：在 ${filePath} 中找不到指定文本`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `已编辑 ${filePath}`;
  } catch (error) {
    return `错误：${(error as Error).message}`;
  }
}

// -- 检测仓库根目录 --
export function detectRepoRoot(cwd: string): string {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      cwd: cwd,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return fs.existsSync(result) ? result : cwd;
  } catch {
    return cwd;
  }
}

// ========================================= Agent 团队 ============================================ //
export const TEAM_DIR = path.join(WORKDIR, ".team");
export const TASKS_DIR = path.join(WORKDIR, ".tasks");
export const INBOX_DIR = path.join(TEAM_DIR, "inbox");
export const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);
