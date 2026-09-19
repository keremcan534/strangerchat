type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: string): void {
  const l = level.toLowerCase() as Level;
  if (l in ORDER) threshold = ORDER[l];
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
