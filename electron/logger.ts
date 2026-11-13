import fs from 'fs';
import path from 'path';
import os from 'os';
import { BrowserWindow } from 'electron';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogSubsystem =
  | 'SYSTEM'
  | 'DB'
  | 'INDEXER'
  | 'CACHE'
  | 'TRANSCODE'
  | 'DEVICE_SYNC'
  | 'SMART_PLAYLIST'
  | 'LISTENBRAINZ'
  | 'LRCLIB'
  | 'ARR_STORE'
  | 'AUTH_OIDC'
  | 'PLAYBACK'
  | 'IPC';

export interface LogEntry {
  id: number;
  timestamp: string;
  formattedTime?: string;
  sessionId?: string;
  level: LogLevel;
  subsystem: LogSubsystem;
  message: string;
  details?: unknown;
  durationMs?: number;
}

const MAX_BUFFER_SIZE = 3000;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function formatLocalDateTime(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

class DiagnosticLogger {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private sessionId: string;
  private logFilePath: string;
  private workspaceLogPath: string;
  private sessionLogPath: string;

  constructor() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.sessionId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
      now.getHours()
    )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    const homeLogDir = path.join(os.homedir(), 'Library', 'Logs', 'RetroTunes');
    const workspaceLogDir = path.join(process.cwd(), 'logs');

    try {
      fs.mkdirSync(homeLogDir, { recursive: true });
    } catch {
      // Fallback if outside sandbox or restricted
    }

    try {
      fs.mkdirSync(workspaceLogDir, { recursive: true });
    } catch {
      // Ignore
    }

    this.logFilePath = path.join(homeLogDir, 'rtunes.log');
    this.workspaceLogPath = path.join(workspaceLogDir, 'rtunes.log');
    this.sessionLogPath = path.join(workspaceLogDir, `rtunes_${this.sessionId}.log`);

    const banner = `\n================================================================================\n[SESSION START] ${formatLocalDateTime(now)} (Session ID: ${this.sessionId})\n================================================================================\n`;
    this.appendToFile(this.workspaceLogPath, banner);
    this.appendToFile(this.sessionLogPath, banner);
    if (this.logFilePath !== this.workspaceLogPath) {
      this.appendToFile(this.logFilePath, banner);
    }
  }

  private sanitizeDetails(details: unknown): unknown {
    if (details === undefined || details === null) return undefined;
    if (details instanceof Error) {
      return {
        name: details.name,
        message: details.message,
        stack: details.stack,
      };
    }
    try {
      const str = JSON.stringify(details, (key, value) => {
        const lower = key.toLowerCase();
        if (
          lower.includes('token') ||
          lower.includes('apikey') ||
          lower.includes('api_key') ||
          lower.includes('secret') ||
          lower.includes('password') ||
          lower === 'authorization'
        ) {
          if (typeof value === 'string' && value.length > 6) {
            return `${value.slice(0, 4)}...[REDACTED len=${value.length}]`;
          }
          return '[REDACTED]';
        }
        return value;
      });
      return JSON.parse(str);
    } catch {
      return String(details);
    }
  }

  public log(
    level: LogLevel,
    subsystem: LogSubsystem,
    message: string,
    details?: unknown,
    durationMs?: number
  ): LogEntry {
    const now = new Date();
    const formattedTime = formatLocalDateTime(now);
    const sanitized = this.sanitizeDetails(details);
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: now.toISOString(),
      formattedTime,
      sessionId: this.sessionId,
      level,
      subsystem,
      message,
      ...(sanitized !== undefined ? { details: sanitized } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_BUFFER_SIZE) {
      this.entries.shift();
    }

    const durationStr = durationMs !== undefined ? ` (${durationMs}ms)` : '';
    const detailStr =
      sanitized !== undefined ? ` | ${JSON.stringify(sanitized)}` : '';
    const formattedLine = `[${formattedTime}] [${level.padEnd(5)}] [${subsystem.padEnd(14)}] ${message}${durationStr}${detailStr}\n`;

    // Console output
    if (level === 'ERROR') {
      console.error(formattedLine.trim());
    } else if (level === 'WARN') {
      console.warn(formattedLine.trim());
    } else {
      console.log(formattedLine.trim());
    }

    // Write to workspace log, session-dated log, and system log
    this.appendToFile(this.workspaceLogPath, formattedLine);
    this.appendToFile(this.sessionLogPath, formattedLine);
    if (this.logFilePath !== this.workspaceLogPath) {
      this.appendToFile(this.logFilePath, formattedLine);
    }

    // Broadcast to renderer windows if available
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send('log:entry', entry);
        }
      }
    } catch {
      // Electron may not be ready yet during early boot
    }

    return entry;
  }

  private appendToFile(filePath: string, line: string) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_LOG_FILE_BYTES) {
          fs.renameSync(filePath, `${filePath}.1`);
        }
      }
      fs.appendFileSync(filePath, line, 'utf8');
    } catch {
      // Ignore file write errors
    }
  }

  public debug(subsystem: LogSubsystem, message: string, details?: unknown, durationMs?: number) {
    return this.log('DEBUG', subsystem, message, details, durationMs);
  }

  public info(subsystem: LogSubsystem, message: string, details?: unknown, durationMs?: number) {
    return this.log('INFO', subsystem, message, details, durationMs);
  }

  public warn(subsystem: LogSubsystem, message: string, details?: unknown, durationMs?: number) {
    return this.log('WARN', subsystem, message, details, durationMs);
  }

  public error(subsystem: LogSubsystem, message: string, details?: unknown, durationMs?: number) {
    return this.log('ERROR', subsystem, message, details, durationMs);
  }

  public getEntries(filter?: {
    level?: LogLevel;
    subsystem?: LogSubsystem;
    search?: string;
    limit?: number;
  }): LogEntry[] {
    let result = [...this.entries];
    if (filter?.level) {
      result = result.filter((e) => e.level === filter.level);
    }
    if (filter?.subsystem) {
      result = result.filter((e) => e.subsystem === filter.subsystem);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      result = result.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          e.subsystem.toLowerCase().includes(q) ||
          (e.details && JSON.stringify(e.details).toLowerCase().includes(q))
      );
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  public clearEntries() {
    this.entries = [];
    this.info('SYSTEM', 'In-memory diagnostic log buffer cleared by user.');
  }

  public getLogPaths() {
    return {
      workspaceLogPath: this.workspaceLogPath,
      sessionLogPath: this.sessionLogPath,
      systemLogPath: this.logFilePath,
      sessionId: this.sessionId,
    };
  }
}

export const logger = new DiagnosticLogger();
