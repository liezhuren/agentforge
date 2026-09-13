/** 极简结构化日志。编排过程很长，没有日志无法判断一次失败发生在哪一步。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
};

export class Logger {
  readonly scope: string;
  private sink: (r: LogRecord) => void;
  private minLevel: LogLevel;

  constructor(scope: string, sink?: (r: LogRecord) => void, minLevel: LogLevel = 'info') {
    this.scope = scope;
    this.minLevel = minLevel;
    this.sink =
      sink ??
      ((r) => {
        const line = `[${r.at}] ${r.level.toUpperCase().padEnd(5)} ${r.scope}: ${r.message}`;
        if (r.level === 'error') console.error(line, r.data ?? '');
        else if (r.level === 'warn') console.warn(line, r.data ?? '');
        else console.log(line, r.data ?? '');
      });
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.sink, this.minLevel);
  }

  private emit(level: LogLevel, message: string, data?: unknown): void {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    if (order[level] < order[this.minLevel]) return;
    this.sink({ at: new Date().toISOString(), level, scope: this.scope, message, data });
  }

  debug(message: string, data?: unknown): void {
    this.emit('debug', message, data);
  }
  info(message: string, data?: unknown): void {
    this.emit('info', message, data);
  }
  warn(message: string, data?: unknown): void {
    this.emit('warn', message, data);
  }
  error(message: string, data?: unknown): void {
    this.emit('error', message, data);
  }
}

/** 收集日志用于断言（测试与回放）。 */
export function collectingLogger(scope = 'test'): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = new Logger(scope, (r) => records.push(r), 'debug');
  return { logger, records };
}

export function silentLogger(scope = 'silent'): Logger {
  return new Logger(scope, () => {}, 'error');
}
