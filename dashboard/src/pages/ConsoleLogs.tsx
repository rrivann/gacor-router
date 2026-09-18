import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, Trash2 } from "lucide-react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { PageHeader } from "../components/ui/PageHeader";
import { cn } from "../lib/utils";
import { useWsEvent } from "../hooks/useWebSocket";
import { clearConsoleLogs as clearApi, fetchConsoleLogs } from "../lib/api";

// Same cap the backend enforces — clamp the UI so a long-lived session
// doesn't grow the DOM unbounded even if a burst of logs arrives while
// we're mounted.
const MAX = 1000;

// Colour per log level. Green is the default so plain console.log() lines
// (the most common) don't scream for attention; INFO/WARN/ERROR/DEBUG each
// get the standard terminal palette so they're easy to spot in a scroll.
const LEVEL_COLOR: Record<string, string> = {
  LOG: "text-success",
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-error",
  DEBUG: "text-primary",
};

function levelOf(line: string): string {
  const m = line.match(/^\[(\w+)\]/);
  return m ? m[1]! : "LOG";
}

export default function ConsoleLogs() {
  const [logs, setLogs] = useState<string[]>([]);
  // Auto-scroll pauses when the user scrolls up to inspect history and
  // resumes when they either scroll back to the bottom or click the
  // "resume" chip below the terminal.
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  // Initial snapshot — WS event stream only carries new lines, so on mount
  // we backfill from the ring buffer via HTTP.
  useEffect(() => {
    fetchConsoleLogs()
      .then((r) => setLogs(r.data.slice(-MAX)))
      .catch(() => {});
  }, []);

  // Live tail. Server emits { line: "..." } for each new line and
  // { clear: true } after DELETE /api/console-logs.
  useWsEvent("console_log", (msg) => {
    const data = msg.data as { line?: string; clear?: boolean };
    if (data.clear) {
      setLogs([]);
      return;
    }
    if (typeof data.line === "string") {
      setLogs((cur) => {
        const next = [...cur, data.line!];
        return next.length > MAX ? next.slice(-MAX) : next;
      });
    }
  });

  // Auto-follow: snap scroll to bottom whenever new logs arrive, unless the
  // user scrolled up. Runs on every logs change so batched arrivals stay
  // in view.
  useEffect(() => {
    if (!autoScroll || !boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, autoScroll]);

  // Detect manual scroll — anything more than ~32px from the bottom means
  // the user is inspecting history, so pause auto-follow.
  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    setAutoScroll(atBottom);
  }, []);

  async function handleClear() {
    // Optimistic wipe — the WS clear event will echo back and paint the
    // same empty state, but this avoids a perceptible round-trip flash.
    setLogs([]);
    try {
      await clearApi();
    } catch {
      // If the DELETE fails, next line from the stream will refill; the
      // user can also just click Clear again.
    }
  }

  function jumpToBottom() {
    setAutoScroll(true);
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Terminal}
        title="Console"
        subtitle="Live router process logs — stdout/stderr streamed to the browser"
        actions={
          <Button variant="outline" size="sm" onClick={handleClear}>
            <Trash2 className="h-4 w-4" /> Clear
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="bg-black p-4 font-mono text-xs h-[calc(100vh-260px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-muted-foreground">No console output yet.</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={cn("whitespace-pre-wrap break-words", LEVEL_COLOR[levelOf(line)] ?? "text-success")}
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
        {!autoScroll && (
          <div className="flex justify-center border-t border-border py-1.5">
            <button
              onClick={jumpToBottom}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Auto-follow paused · click to resume
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
