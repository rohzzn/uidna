/**
 * Debug logging to stderr. The MCP server speaks JSON-RPC on stdout, so
 * nothing in UI DNA may ever print diagnostics there.
 */

/** Minimal logger interface. */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Create a logger that writes to stderr; `debug` lines only when `verbose`. */
export function createLogger(verbose: boolean, prefix = 'uidna'): Logger {
  const write = (level: string, message: string, data?: Record<string, unknown>): void => {
    const suffix = data && Object.keys(data).length > 0 ? ' ' + safeJson(data) : '';
    process.stderr.write(`[${prefix}] ${level} ${message}${suffix}\n`);
  };
  return {
    debug: (m, d) => {
      if (verbose) write('debug', m, d);
    },
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

/** A logger that discards everything (tests, quiet mode). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
