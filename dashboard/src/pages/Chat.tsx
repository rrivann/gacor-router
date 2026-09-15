import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  MessageSquarePlus,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { fetchModels, type ModelInfo } from "../lib/api";
import { useChatSessions, deriveTitle } from "../hooks/useChatSessions";
import { AiMarkdown } from "../components/chat/AiMarkdown";
import { Dialog } from "../components/ui/dialog";

// ── Types ────────────────────────────────────────────────────────
// Messages are OpenAI-shaped so the full history can be sent straight back
// to /v1/chat/completions each turn. UI-only fields (images, reasoning) are
// stripped by wire() before sending.
interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning?: string;
  images?: string[]; // data URLs (user) or generated (assistant)
}

const LS = {
  model: "gacor.chat-model",
  sys: "gacor.chat-sys",
};

const DEFAULT_SYSTEM = `You are a helpful assistant running inside the Gacor-Router dashboard.
Reply in the same language the user writes in. Be concise and precise.`;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

// Strip UI-only fields, encode multimodal user messages as content parts.
function wire(history: ChatMsg[], sysPrompt: string) {
  const out: Record<string, unknown>[] = history.map((m) => {
    if (m.role === "user" && m.images?.length) {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const url of m.images) parts.push({ type: "image_url", image_url: { url } });
      return { role: "user", content: parts };
    }
    return { role: m.role, content: m.content };
  });
  if (sysPrompt.trim()) out.unshift({ role: "system", content: sysPrompt.trim() });
  return out;
}

// ── Main page ────────────────────────────────────────────────────

export default function Chat() {
  const chats = useChatSessions();
  const { activeId } = chats;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState(() => load<string>(LS.model, ""));
  const [sysPrompt, setSysPrompt] = useState(() => load<string>(LS.sys, DEFAULT_SYSTEM));
  const [showSys, setShowSys] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [attachments, setAttachments] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadedForRef = useRef<number | null>(null);

  // ── Model catalogue ────────────────────────────────────────────
  const loadModels = useCallback(() => {
    fetchModels()
      .then((r) => {
        setModels(r.data);
        setModel((cur) =>
          cur && r.data.some((m) => m.id === cur) ? cur : (r.data[0]?.id ?? "")
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // ── Session load / persist ─────────────────────────────────────
  useEffect(() => {
    if (activeId == null) {
      setMsgs([]);
      loadedForRef.current = null;
      return;
    }
    if (loadedForRef.current === activeId) return;
    loadedForRef.current = activeId;
    chats
      .load(activeId)
      .then((s) => {
        let parsed: ChatMsg[] = [];
        try {
          parsed = s.messages ? (JSON.parse(s.messages) as ChatMsg[]) : [];
        } catch {
          parsed = [];
        }
        setMsgs(parsed);
        if (s.model) setModel(s.model);
      })
      .catch(() => setMsgs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Persist when a turn settles (skip mid-stream so we don't serialize the
  // whole history every frame).
  useEffect(() => {
    if (busy || activeId == null || loadedForRef.current !== activeId) return;
    const firstUser = msgs.find((m) => m.role === "user");
    const title = deriveTitle(firstUser?.content ?? "");
    const t = setTimeout(() => {
      chats.save(activeId, title, model, JSON.stringify(msgs.slice(-200)), msgs.length).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, busy, activeId, model]);

  useEffect(() => {
    if (model) localStorage.setItem(LS.model, JSON.stringify(model));
  }, [model]);
  useEffect(() => {
    localStorage.setItem(LS.sys, JSON.stringify(sysPrompt));
  }, [sysPrompt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [msgs, busy]);

  // ── Streaming ──────────────────────────────────────────────────
  async function callModel(history: ChatMsg[], ac: AbortController): Promise<void> {
    // Image models take one turn's user text as a prompt and return URLs.
    // No streaming, no history — every turn is a fresh generation.
    const selected = models.find((m) => m.id === model);
    if (selected?.kind === "image") {
      const lastUser = [...history].reverse().find((m) => m.role === "user");
      const prompt = lastUser?.content?.trim();
      if (!prompt) throw new Error("image generation needs a text prompt");
      const res = await fetch("/v1/images/generations", {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }),
      });
      if (!res.ok) {
        throw new Error((await res.text().catch(() => "")) || `request failed (${res.status})`);
      }
      const body = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
      const urls = (body.data ?? [])
        .map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ""))
        .filter(Boolean);
      if (urls.length === 0) throw new Error("image response had no data");
      setMsgs((p) => [...p, { role: "assistant", content: "", images: urls }]);
      return;
    }

    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: wire(history, sysPrompt) }),
    });
    if (!res.ok || !res.body) {
      throw new Error((await res.text().catch(() => "")) || `request failed (${res.status})`);
    }

    const assistant: ChatMsg = { role: "assistant", content: "" };
    setMsgs((p) => [...p, assistant]);

    // Coalesce state updates to one per animation frame — per-token setState
    // triggers thousands of re-renders on long replies.
    let dirty = false;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!dirty) return;
      dirty = false;
      setMsgs((p) => [...p.slice(0, -1), { ...assistant }]);
    };
    const schedule = () => {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const data = s.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: { choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            assistant.content += delta.content;
            schedule();
          }
          if (delta.reasoning_content) {
            assistant.reasoning = (assistant.reasoning ?? "") + delta.reasoning_content;
            schedule();
          }
        }
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
    }
    setMsgs((p) => [...p.slice(0, -1), { ...assistant }]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy || !model) return;
    setErr("");
    if (activeId == null) {
      try {
        const id = await chats.create(model);
        // The create flips activeId, which would normally trigger the session
        // load effect — and that load would wipe the user message we're about
        // to set. Mark it as already-loaded so the effect skips it; the
        // persist effect below saves the real messages when the turn settles.
        loadedForRef.current = id;
      } catch {
        // keep going in-memory; persistence will retry on next turn
      }
    }
    setInput("");
    const imgs = attachments;
    setAttachments([]);

    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    const history: ChatMsg[] = [
      ...msgs,
      { role: "user", content: text, images: imgs.length ? imgs : undefined },
    ];
    setMsgs(history);
    try {
      await callModel(history, ac);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    stop();
    setErr("");
    setMsgs([]);
    loadedForRef.current = null;
    chats.setActive(null);
  };

  const openChat = (id: number) => {
    if (id === activeId) return;
    stop();
    setErr("");
    chats.setActive(id);
  };

  const deleteChat = async (id: number) => {
    await chats.remove(id).catch(() => {});
    if (id === activeId) {
      setMsgs([]);
      loadedForRef.current = null;
    }
  };

  const pickImages = (files: FileList | null) => {
    if (!files) return;
    Array.from(files)
      .slice(0, 4)
      .forEach((f) => {
        if (!f.type.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = () => setAttachments((p) => [...p, String(reader.result)].slice(0, 6));
        reader.readAsDataURL(f);
      });
  };

  const activeTitle =
    chats.sessions?.find((s) => s.id === activeId)?.title ?? "New chat";

  return (
    <div className="flex h-screen overflow-hidden">
      {/* History sidebar */}
      {sidebarOpen && (
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar-bg">
          <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</span>
            <div className="flex-1" />
            <button
              onClick={newChat}
              title="New chat"
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-secondary-foreground hover:bg-secondary"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <SessionList sessions={chats.sessions} activeId={activeId} onOpen={openChat} onDelete={deleteChat} />
          </div>
        </aside>
      )}

      {/* Chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              title="Show history"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{activeTitle}</span>
          <div className="flex-1" />
          <button
            onClick={() => setSidebarOpen(false)}
            title="Hide history"
            className={cn("rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground", !sidebarOpen && "hidden")}
          >
            <X className="h-4 w-4" />
          </button>
          <button
            onClick={newChat}
            title="New chat"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowSys(true)}
            title="System prompt"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>

        {showSys && (
          <SystemPromptModal value={sysPrompt} onSave={(v) => { setSysPrompt(v); setShowSys(false); }} onClose={() => setShowSys(false)} />
        )}

        {/* Messages */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {msgs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
              <Bot className="mb-2 h-8 w-8" />
              <p className="text-sm">Chat with your gateway models.</p>
              <p className="text-xs">Pick a model below and say something — streaming, markdown, images supported.</p>
            </div>
          )}
          <Conversation msgs={msgs} busy={busy} />
          {err && (
            <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{err}</div>
          )}
        </div>

        {/* Composer */}
        <div className="p-3">
          <div className="rounded-xl border border-border bg-card focus-within:border-primary/50">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 border-b border-border/60 p-2">
                {attachments.map((src, i) => (
                  <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-lg border border-border">
                    <img src={src} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                      className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white/80 opacity-0 group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => {
                const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (imgs.length) {
                  e.preventDefault();
                  pickImages(e.clipboardData.files);
                }
              }}
              placeholder={model ? "What would you like to work on?" : "Loading models…"}
              rows={2}
              className="max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1.5 px-2 pb-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  pickImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach image"
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </button>
              <ModelPicker models={models} model={model} setModel={setModel} onOpen={loadModels} />
              <div className="flex-1" />
              {busy ? (
                <button
                  onClick={stop}
                  title="Stop"
                  className="flex h-7 items-center gap-1.5 rounded-lg bg-error/15 px-2.5 text-xs text-error hover:bg-error/25"
                >
                  <Square className="h-3.5 w-3.5" /> Stop
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!input.trim() && attachments.length === 0}
                  title="Send"
                  className="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" /> Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function SessionList({
  sessions,
  activeId,
  onOpen,
  onDelete,
}: {
  sessions: { id: number; title: string; msgCount: number; updatedAt: string }[] | null;
  activeId: number | null;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  if (!sessions || sessions.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No chats yet</p>;
  }
  return (
    <div className="space-y-0.5">
      {sessions.map((s) => (
        <div
          key={s.id}
          onClick={() => onOpen(s.id)}
          className={cn(
            "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
            s.id === activeId ? "bg-primary/15 text-primary" : "text-secondary-foreground hover:bg-secondary"
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate">{s.title}</div>
            <div className="text-[10px] text-muted-foreground">
              {s.msgCount} msg · {relTime(s.updatedAt)}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s.id);
            }}
            title="Delete"
            className="rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-error group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const TextBlock = memo(function TextBlock({ content }: { content: string }) {
  return (
    <div className="min-w-0">
      <AiMarkdown text={content} />
    </div>
  );
});

const ReasoningBlock = memo(function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        thinking
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border bg-background p-2 text-xs italic text-muted-foreground">
          {content}
        </div>
      )}
    </div>
  );
});

const ThinkingDots = memo(function ThinkingDots() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-secondary/70 px-3.5 py-2.5 text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
      </div>
    </div>
  );
});

const Conversation = memo(function Conversation({ msgs, busy }: { msgs: ChatMsg[]; busy: boolean }) {
  const shown = msgs.slice(-60); // keep long chats light
  // Between "user sent" and "first streamed chunk" there's no assistant
  // message yet — show the dots on their own row so the wait is visible.
  const waiting = busy && shown.length > 0 && shown[shown.length - 1]!.role === "user";
  return (
    <>
      {shown.map((m, i) => {
        const last = i === shown.length - 1;
        if (m.role === "user") {
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] space-y-1.5">
                {m.images && m.images.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {m.images.map((src, j) => (
                      <img key={j} src={src} alt="" className="h-20 w-20 rounded-lg border border-border object-cover" />
                    ))}
                  </div>
                )}
                {m.content && (
                  <div className="rounded-2xl rounded-br-sm bg-primary/15 px-3.5 py-2 text-sm">{m.content}</div>
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="flex justify-start">
            <div className="max-w-[85%] min-w-0 space-y-2">
              {m.reasoning && <ReasoningBlock content={m.reasoning} />}
              {m.content && <TextBlock content={m.content} />}
              {m.images && m.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {m.images.map((src, j) => (
                    <a key={j} href={src} target="_blank" rel="noreferrer" className="block">
                      <img
                        src={src}
                        alt="generated"
                        className="max-h-96 max-w-full rounded-lg border border-border object-contain"
                      />
                    </a>
                  ))}
                </div>
              )}
              {!m.content && !m.images?.length && last && busy && (
                <div className="flex items-center gap-1.5 py-1 text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {waiting && <ThinkingDots />}
    </>
  );
});

function ModelPicker({
  models,
  model,
  setModel,
  onOpen,
}: {
  models: ModelInfo[];
  model: string;
  setModel: (m: string) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? models.filter((m) => m.id.toLowerCase().includes(f)) : models;
  }, [models, filter]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (!open) onOpen();
          setOpen((v) => !v);
        }}
        className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-secondary-foreground hover:bg-secondary"
      >
        <span className="truncate">{model || "pick model"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute bottom-9 left-0 z-50 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--shadow-card)]">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search models…"
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs outline-none focus-visible:outline-2 focus-visible:outline-ring"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {shown.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No match</p>}
            {shown.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setModel(m.id);
                  setOpen(false);
                  setFilter("");
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary",
                  m.id === model && "bg-primary/15 text-primary"
                )}
              >
                <span className="truncate font-mono">{m.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SystemPromptModal({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Dialog open onClose={onClose} title="System Prompt">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={8}
        className="w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={() => setDraft(DEFAULT_SYSTEM)}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-secondary-foreground hover:bg-secondary"
        >
          Reset
        </button>
        <button onClick={() => onSave(draft)} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/85">
          Save
        </button>
      </div>
    </Dialog>
  );
}
