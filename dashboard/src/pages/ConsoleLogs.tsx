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

// 9router-inspired terminal palette — pattern-matched, not level-matched.
// Glyph prefixes (▶ POST, 📊 DONE, ✗ ERROR) win over the [LEVEL] tag so a
// rotation trace reads at a glance: yellow starts, cyan completes, red
// fails, orange rotates. Tag-scoped colours ([RTK], [tunnel], [AUTH], …)
// come next so operator activity stands out from generic INFO lines. Level
// is the fallback for anything without a marker (console.log() → green).
//
// Direct Tailwind palette classes (not semantic tokens) — terminal output
// wants an authentic screen-of-code look, not our app's muted UI palette.
function colorLine(line: string): string {
  // Request start — headline of every attempt. Bright yellow so a burst of
  // rotation is scannable.
  if (line.includes("▶ POST")) return "text-yellow-300";
  // Success completion — paired visual echo of ▶. Cyan/blue contrasts with
  // the yellow start line so the pair reads as one block.
  if (line.includes("📊 DONE")) return "text-cyan-300";
  // Hard failure on a request.
  if (line.includes("✗ ERROR")) return "text-red-400";
  // Rotation-related warnings that fire in bursts when a pool goes down.
  if (line.includes("[FALLBACK]")) return "text-orange-300";
  if (line.includes("[AUTH]")) return "text-yellow-400";
  // RTK savings — amber to nod at "efficiency" alongside the tunnel blue
  // family. Also mirrors 9router's log colour for the same tag.
  if (line.includes("[RTK]")) return "text-amber-300";
  // CL4ude Code identity capture — same amber family as RTK but brighter,
  // so a rare event pops when it happens alongside the constant RTK stream.
  if (line.includes("[CL4udeHeaders]")) return "text-amber-400";
  // Tunnel state machine + shortId + register.
  if (line.includes("[tunnel]")) return "text-sky-300";
  // Generic content-filter line (still comes through as plain LOG level).
  if (line.startsWith("filters:")) return "text-fuchsia-300";
  // Fallback per level tag.
  const m = line.match(/^\[(\w+)\]/);
  const level = m ? m[1] : "LOG";
  switch (level) {
    case "INFO":
      return "text-blue-300";
    case "WARN":
      return "text-yellow-300";
    case "ERROR":
      return "text-red-400";
    case "DEBUG":
      return "text-purple-300";
    default:
      return "text-green-300";
  }
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
                <div key={i} className={cn("whitespace-pre-wrap break-words", colorLine(line))}>
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
