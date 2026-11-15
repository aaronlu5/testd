import { LOG_LEVELS, type LogLevel } from '@test-platform/contracts';
import {
  systemClock,
  type Clock,
  type LogFields,
  type Logger,
  type Redactor,
} from '@test-platform/core';

export type LogSink = (line: string) => void;

export type JsonLoggerOptions = {
  level?: LogLevel;
  sink?: LogSink;
  clock?: Clock;
  /** Masks values and registered secrets in the message and fields. */
  redactor?: Redactor;
  bindings?: LogFields;
};

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** One JSON object per line; reserved keys (`time`, `level`, `msg`) cannot be overridden by fields. */
export const createJsonLogger = (options: JsonLoggerOptions = {}): Logger => {
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info');
  const sink = options.sink ?? stdoutSink;
  const clock = options.clock ?? systemClock;
  const redactor = options.redactor;
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const merged = { ...bindings, ...fields };
    const safeFields = (redactor ? redactor.redact(merged) : merged) as Record<string, unknown>;
    const record = {
      ...safeFields,
      time: clock.now().toISOString(),
      level,
      msg: redactor ? redactor.redactText(message) : message,
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      sink(
        JSON.stringify({
          time: record.time,
          level,
          msg: record.msg,
          logError: 'fields were not serializable',
        }),
      );
    }
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (extra) => createJsonLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
};
