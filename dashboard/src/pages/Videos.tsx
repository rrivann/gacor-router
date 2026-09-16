import { useCallback, useEffect, useState } from "react";
import {
  Download,
  Film,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog } from "../components/ui/dialog";
import {
  deleteVideo,
  fetchVideos,
  submitVideo,
  videoDownloadUrl,
  type VideoJobRow,
  type VideoStatusEvent,
} from "../lib/api";
import { cn, formatDateTime } from "../lib/utils";
import { useTimedMessage } from "../hooks/useTimedMessage";
import { useWsEvent } from "../hooks/useWebSocket";

// Video generation jobs page. Async lifecycle: submit → queued → in_progress
// → completed | failed. The background poller drives the transitions; this
// page just reflects them (initial fetch + WS live updates).

export default function Videos() {
  const [rows, setRows] = useState<VideoJobRow[] | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<VideoJobRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoJobRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useTimedMessage<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchVideos();
      setRows(r.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates: merge existing rows by id, prepend new ones.
  useWsEvent("video_status", (msg) => {
    const ev = msg.data as VideoStatusEvent;
    setRows((current) => {
      if (!current) return current;
      const idx = current.findIndex((r) => r.id === ev.id);
      if (idx === -1) {
        // New job (submitted from another dashboard tab, curl, etc). Trigger
        // a full re-fetch so we get the missing account/params columns.
        load();
        return current;
      }
      const next = [...current];
      next[idx] = { ...next[idx], ...eventPatch(ev) };
      return next;
    });
  });

  function ok(text: string) {
    setMessage(text);
    setError(null);
  }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    clearMessage();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteVideo(deleteTarget.id);
      ok(`Video #${deleteTarget.id} deleted`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Videos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Async generation via <code className="rounded bg-secondary px-1 py-0.5 text-xs">POST /v1/videos/generations</code>.
            Poller drives progress; mp4 lands in <code className="rounded bg-secondary px-1 py-0.5 text-xs">./videos/</code>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setSubmitOpen(true)}>
            <Plus className="h-4 w-4" /> New video
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>
      )}
      {message && !error && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {message}
        </div>
      )}

      <Card>
        {!rows ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="space-y-2 py-12 text-center">
            <Film className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">No videos yet</div>
            <p className="mx-auto max-w-md text-xs text-muted-foreground">
              Submit a video job — takes ~3-4 minutes to render at 720P, uses
              ~21 credits per second. The mp4 auto-downloads to the router.
            </p>
            <Button size="sm" onClick={() => setSubmitOpen(true)}>
              <Plus className="h-4 w-4" /> New video
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Prompt</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Params</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/60 last:border-0 hover:bg-secondary/40"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">#{row.id}</td>
                    <td className="px-4 py-2.5">
                      <div className="max-w-[280px] truncate" title={row.params.prompt}>
                        {row.params.prompt}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      <div>{row.model}</div>
                      <div className="text-[10px]">
                        {row.accountLabel ? `via ${row.accountLabel}` : `#${row.accountId}`}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                      {row.params.seconds}s · {row.params.resolution} · {row.params.aspectRatio}
                      {row.params.audio && <span className="ml-1 text-[10px] uppercase">+audio</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={row.status} />
                      {row.errorMessage && (
                        <div className="mt-0.5 max-w-[200px] truncate text-[10px] text-error" title={row.errorMessage}>
                          {row.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                      {row.creditUsed != null ? row.creditUsed.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {row.status === "completed" && (
                          <>
                            <button
                              onClick={() => setPreviewTarget(row)}
                              title="Preview"
                              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-primary"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                            <a
                              href={videoDownloadUrl(row.id)}
                              download={`video-${row.id}.mp4`}
                              title="Download"
                              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </>
                        )}
                        <button
                          onClick={() => setDeleteTarget(row)}
                          title="Delete"
                          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-error"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <SubmitDialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={(row) => {
          ok(`Submitted job #${row.id} — polling for ~3-4 minutes`);
          setSubmitOpen(false);
          load();
        }}
        onError={fail}
      />

      {previewTarget && (
        <PreviewDialog row={previewTarget} onClose={() => setPreviewTarget(null)} />
      )}

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete video">
        <p className="text-sm text-muted-foreground">
          This removes job <span className="font-mono">#{deleteTarget?.id}</span> from the database
          and unlinks its mp4 from disk. Can't be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    queued: "border-info/30 bg-info/10 text-info",
    in_progress: "border-warning/30 bg-warning/10 text-warning",
    completed: "border-success/30 bg-success/10 text-success",
    failed: "border-error/30 bg-error/10 text-error",
  };
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
        tone[status] ?? "border-border bg-secondary text-muted-foreground"
      )}
    >
      {status}
    </span>
  );
}

// Merge the WS event's mutable fields onto an existing row. The event
// intentionally doesn't carry immutable fields (provider, model, apiKeyId,
// requestLogId) so the merge only overwrites what really changed.
function eventPatch(ev: VideoStatusEvent): Partial<VideoJobRow> {
  return {
    status: ev.status,
    filePath: ev.filePath,
    fileSize: ev.fileSize,
    creditUsed: ev.creditUsed,
    errorMessage: ev.errorMessage,
    updatedAt: ev.updatedAt,
    completedAt: ev.completedAt,
    accountLabel: ev.accountLabel,
    params: ev.params,
  };
}

interface SubmitDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmitted: (row: { id: number }) => void;
  onError: (err: unknown) => void;
}

function SubmitDialog({ open, onClose, onSubmitted, onError }: SubmitDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("4");
  const [resolution, setResolution] = useState<"720P" | "1080P">("720P");
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset on open — the accounts add flow burned us once when a stale value
  // lingered across opens; keep the same discipline here.
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setSeconds("4");
    setResolution("720P");
    setAspect("16:9");
    setAudio(false);
    setBusy(false);
  }, [open]);

  const secondsNum = Number(seconds) || 0;
  const invalid = !prompt.trim() || secondsNum < 4 || secondsNum > 30;
  const estCredit = Math.round(secondsNum * 21);

  async function handleSubmit() {
    if (invalid) return;
    setBusy(true);
    try {
      const row = await submitVideo({
        model: "codebuddy/seedance-2.5",
        prompt: prompt.trim(),
        seconds: secondsNum,
        resolution,
        aspect_ratio: aspect,
        audio,
      });
      onSubmitted(row);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New video">
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A cat walking gracefully across a sunny room"
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Seconds (4-30)</span>
            <Input
              value={seconds}
              onChange={(e) => setSeconds(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Resolution</span>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value as "720P" | "1080P")}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="720P">720P</option>
              <option value="1080P">1080P</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Aspect</span>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as "16:9" | "9:16" | "1:1")}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={audio}
            onChange={(e) => setAudio(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <span>Enable audio track</span>
        </label>

        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-secondary-foreground">
          <div className="font-medium">Estimated cost: ~{estCredit} credits</div>
          <div className="mt-0.5 text-muted-foreground">
            Charged to the account the pool picks. Render takes ~3-4 minutes; the mp4
            appears here when the poller finishes it.
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={invalid || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Submit
        </Button>
      </div>
    </Dialog>
  );
}

function PreviewDialog({ row, onClose }: { row: VideoJobRow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <video
          controls
          autoPlay
          src={videoDownloadUrl(row.id)}
          className="max-h-[70vh] w-full bg-black"
        />
        <div className="space-y-2 border-t border-border p-4 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Job #{row.id}</div>
              <div className="text-xs text-muted-foreground">{row.model} · task {row.taskId.slice(0, 20)}…</div>
            </div>
            <div className="text-right">
              <div className="tabular-nums">{row.creditUsed?.toFixed(2) ?? "—"} credits</div>
              <div className="text-xs text-muted-foreground">
                {row.fileSize ? `${(row.fileSize / 1024 / 1024).toFixed(2)} MB` : "—"}
              </div>
            </div>
          </div>
          <div className="text-xs text-secondary-foreground">
            <span className="text-muted-foreground">Prompt:</span> {row.params.prompt}
          </div>
          <div className="text-xs text-muted-foreground">
            {row.params.seconds}s · {row.params.resolution} · {row.params.aspectRatio}
            {row.params.audio && " · audio"}
            {row.completedAt && ` · finished ${formatDateTime(row.completedAt)}`}
          </div>
          <div className="pt-1">
            <a
              href={videoDownloadUrl(row.id)}
              download={`video-${row.id}.mp4`}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5" /> Download mp4
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
