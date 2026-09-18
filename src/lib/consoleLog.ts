// Router-process console capture. Monkey-patches console.{log,info,warn,error,
// debug} to append each line into a bounded ring buffer and fan it out via
// the same WS event bus that carries request/account/video events. The
// dashboard's /console-log page subscribes to `console_log` events and
// paints them live — same shape 9router's console log page uses.
//
// Idempotent: initConsoleLogCapture() is safe to call multiple times; the
// second call is a no-op. Pass-through to the real console preserves the
// terminal output for VPS operators watching journalctl.

import { emit, EV_CONSOLE_LOG } from "./events";

// 1000 lines ~ few hundred KB — the same cap 9router picked. Enough scroll
// history for live debugging without holding the process hostage.
const MAX_LINES = 1000;
// ANSI escape codes leak from libraries that colour their own output
// (drizzle-kit, chalk-style debuggers). Strip so the browser doesn't
// render `\x1b[...m` literally.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type Level = (typeof LEVELS)[number];

interface State {
  lines: string[];
  patched: boolean;
  originals: Partial<Record<Level, (...args: unknown[]) => void>>;
}

const state: State = {
  lines: [],
  patched: false,
  originals: {},
};

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function fmt(arg: unknown): string {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack ?? arg.message ?? String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function toLine(level: Level, args: unknown[]): string {
  // Same shape as 9router's ConsoleLogClient parses: "[LEVEL] rendered line".
  return `[${level.toUpperCase()}] ${args.map(fmt).join(" ")}`;
}

function append(line: string): void {
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) {
    // Trim from the head — new writes stay in bounded slice space, GC frees
    // the old array on the next append.
    state.lines = state.lines.slice(-MAX_LINES);
  }
  emit(EV_CONSOLE_LOG, { line });
}

export function initConsoleLogCapture(): void {
  if (state.patched) return;
  for (const level of LEVELS) {
    // Bind the original so passthrough writes still land on the real stream
    // even after we take ownership of the property.
    state.originals[level] = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      append(toLine(level, args));
      state.originals[level]?.(...args);
    };
  }
  state.patched = true;
}

export function getConsoleLogs(): string[] {
  // Return the same array reference the API endpoint reads — JSON.stringify
  // freezes a snapshot at serialization time, so no defensive copy needed.
  return state.lines;
}

export function clearConsoleLogs(): void {
  state.lines = [];
  emit(EV_CONSOLE_LOG, { clear: true });
}
