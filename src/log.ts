/**
 * Structured JSON logging.
 *
 * Contract: `log()` can never throw and never rejects. It sits inside `finally` blocks on socket
 * teardown paths and inside detached discovery pumps, where a throw would escape as an unhandled
 * rejection instead of a logged blip.
 */

import { config } from "./config.ts";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFor(name: string): number {
  const level = name.toLowerCase();
  return level in ORDER ? ORDER[level as Level] : ORDER.info;
}

const threshold = thresholdFor(config.logLevel);

export type Fields = Record<string, unknown>;

function emit(level: Level, event: string, fields?: Fields): void {
  if (ORDER[level] < threshold) return;
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  } catch {
    // Circular or otherwise unserialisable field: never lose the event over a bad payload.
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      fields: "<unserialisable>",
    });
  }
  try {
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  } catch {
    // Console itself failed. Nothing useful left to do, and this must stay silent.
  }
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/** Normalise an unknown thrown value into loggable fields. */
export function errFields(err: unknown): Fields {
  if (err instanceof Error) {
    return { err: err.name, msg: err.message, ...(err.cause ? { cause: String(err.cause) } : {}) };
  }
  return { err: "NonError", msg: String(err) };
}

/** True when a failure is a deliberate cancellation rather than something worth alarming about. */
export function isAbort(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError");
}
