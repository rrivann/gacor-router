import { useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, X } from "lucide-react";
import { fetchDebugProcess, type DebugProcess } from "../../lib/api";
import { Sparkline } from "../Sparkline";

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const CAP = 40;
const POLL_MS = 5000;

// Sidebar footer CPU/MEM readout for the router process itself; click opens
// the Debug popover (sparklines + runtime + build info), mirroring enowx.
export function DebugStats() {
  const [info, setInfo] = useState<DebugProcess | null>(null);
  const [open, setOpen] = useState(false);
  const cpuHist = useRef<number[]>([]);
  const memHist = useRef<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const d = await fetchDebugProcess();
        if (stopped) return;
        setInfo(d);
        cpuHist.current = [...cpuHist.current, d.process.cpuPercent].slice(-CAP);
        memHist.current = [...memHist.current, Math.round(d.process.rss / 1024 / 1024)].slice(-CAP);
      } catch {
        // Server unreachable — the WS indicator already shows that.
      }
    }
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  // Close the popover on any outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const cpu = info ? Math.round(info.process.cpuPercent) : 0;
  const memMB = info ? Math.round(info.process.rss / 1024 / 1024) : 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title="Process debug"
      >
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3 text-primary" /> {cpu}%
        </span>
        <span className="flex items-center gap-1">
          <MemoryStick className="h-3 w-3 text-primary" /> {memMB}MB
        </span>
        <span className="ml-auto text-[9px] uppercase tracking-wide opacity-60">debug</span>
      </button>

      {open && info && (
        <DebugPopover info={info} cpuHist={cpuHist.current} memHist={memHist.current} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function DebugPopover({
  info,
  cpuHist,
  memHist,
  onClose,
}: {
  info: DebugProcess;
  cpuHist: number[];
  memHist: number[];
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-9 left-0 z-50 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold">Debug · Gacor-Router process</span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[70vh] space-y-3 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-2">
          <Card title="CPU" value={`${info.process.cpuPercent}%`}>
            <Sparkline values={cpuHist} />
          </Card>
          <Card title="MEM (RSS)" value={mb(info.process.rss)}>
            <Sparkline values={memHist} />
          </Card>
        </div>

        <Section title="RUNTIME">
          <Row k="Heap used" v={mb(info.memory.heapUsed)} />
          <Row k="Heap total" v={mb(info.memory.heapTotal)} />
          <Row k="External" v={mb(info.memory.external)} />
          <Row k="ArrayBuffers" v={mb(info.memory.arrayBuffers)} />
          <Row k="Event loop delay" v={`${info.eventLoop.delayMs} ms`} />
        </Section>

        <Section title="BUILD">
          <Row k="Bun" v={info.build.bunVersion} />
          <Row k="Platform" v={`${info.build.platform}/${info.build.arch}`} />
          <Row k="CPUs" v={String(info.build.numCpu)} />
          <Row k="PID" v={String(info.process.pid)} />
          <Row k="Uptime" v={fmtUptime(info.uptimeSeconds)} />
        </Section>
      </div>
    </div>
  );
}

function Card({ title, value, children }: { title: string; value: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-background p-2.5">
      <span className="font-mono text-[10px] tracking-widest text-primary">{title}</span>
      <div className="my-1 text-lg font-bold tabular-nums">{value}</div>
      <div className="text-primary">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-2.5">
      <p className="mb-1.5 font-mono text-[10px] tracking-widest text-muted-foreground">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between font-mono text-[11px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular-nums text-foreground/80">{v}</span>
    </div>
  );
}
