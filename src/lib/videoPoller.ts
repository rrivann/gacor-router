// Background poller for /v1/videos jobs. Runs once per instance from boot,
// sweeps every pending (queued | in_progress) row on a fixed cadence, calls
// the provider's pollVideo(), and drives the row to a terminal state:
//   - completed  → downloads the signed mp4 to ./videos/{id}.mp4 and stamps
//                  filePath/fileSize/creditUsed.
//   - failed     → stamps errorMessage.
// Every transition fans out an EV_VIDEO_STATUS event so the dashboard's WS
// clients re-render live.
//
// A single background loop is enough — the router is single-user local-first
// and we don't want two workers racing on the same task id.

import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { registry } from "../providers";
import { getAccount, updateCreds } from "../db/accounts";
import { listPendingJobs, markCompleted, markFailed, updateVideoJob, getVideoJob } from "../db/videoJobs";
import { addApiKeyUsage } from "../db/apiKeys";
import { updateRequestLog, getRequestLog } from "../db/logs";
import { emit, EV_REQUEST_LOG, EV_VIDEO_STATUS } from "./events";
import type { Account, Provider, VideoPollResult } from "../providers/types";

// mp4s land here. Kept alongside the DB so a `rsync` of the project directory
// captures the state clients rely on.
export const VIDEOS_DIR = resolve("./videos");

function ensureVideosDir(): void {
  if (!existsSync(VIDEOS_DIR)) mkdirSync(VIDEOS_DIR, { recursive: true });
}

// Poll one job once. Returns the new status (or null if nothing changed).
async function pollOnce(job: ReturnType<typeof listPendingJobs>[number]): Promise<void> {
  const row = getAccount(job.accountId);
  if (!row) {
    markFailed(job.id, `account #${job.accountId} deleted before poll — job orphaned`);
    emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
    return;
  }
  const provider = registry.get(row.provider);
  if (!provider?.pollVideo) {
    markFailed(job.id, `provider "${row.provider}" no longer supports pollVideo`);
    emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
    return;
  }

  let acc: Account = { id: row.id, label: row.label ?? `#${row.id}`, secret: row.secret, creds: row.creds ?? {} };
  if (provider.refresh) {
    const refreshed = await provider.refresh(acc);
    if (!refreshed) {
      markFailed(job.id, `credential refresh failed for account #${row.id}`);
      emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
      return;
    }
    if (refreshed.creds !== acc.creds) updateCreds(row.id, refreshed.creds);
    acc = refreshed;
  }

  let result: VideoPollResult;
  try {
    result = await provider.pollVideo(job.taskId, acc);
  } catch (err) {
    // Network/transient — leave status alone, try again on the next tick.
    console.warn(`[videoPoller] poll #${job.id} threw:`, err instanceof Error ? err.message : err);
    return;
  }

  if (result.status === "failed") {
    markFailed(job.id, result.errorMessage ?? "upstream reported failed");
    emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
    return;
  }

  if (result.status === "completed") {
    if (!result.url) {
      markFailed(job.id, "completed without a download URL");
      emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
      return;
    }
    await downloadAndFinalize(job.id, result, provider, acc);
    return;
  }

  // queued → in_progress transition (or same status): stamp updatedAt + emit
  // so clients see the lifecycle move.
  if (result.status !== job.status) {
    updateVideoJob(job.id, { status: result.status, updatedAt: new Date() });
    emit(EV_VIDEO_STATUS, videoEventPayload(job.id));
  }
}

async function downloadAndFinalize(
  jobId: number,
  result: VideoPollResult,
  _provider: Provider,
  _acc: Account
): Promise<void> {
  const url = result.url!;
  const target = join(VIDEOS_DIR, `${jobId}.mp4`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      markFailed(jobId, `download failed: HTTP ${resp.status}`);
      emit(EV_VIDEO_STATUS, videoEventPayload(jobId));
      return;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    await Bun.write(target, buf);

    // Charge the paying key against its token budget so the video cost is
    // visible in the same book as chat/image. The upstream's `output_tokens`
    // (not `credit`) is the tokens-equivalent value it charges internally.
    const job = getVideoJob(jobId);
    const tokensCharge = result.outputTokens ?? 0;
    if (job?.apiKeyId && tokensCharge > 0) {
      addApiKeyUsage(job.apiKeyId, tokensCharge);
    }

    markCompleted(jobId, {
      filePath: target,
      fileSize: buf.length,
      videoUrl: url,
      creditUsed: result.credit ?? 0,
      // Video pricing is per-second, not per-token — the token pricing table
      // doesn't apply. Leave dollarCost null until a per-model rate lands.
      dollarCost: null,
    });

    // Backfill the submit-time request_logs row with the final cost + render
    // duration. Without this, the Requests view would show a 200ms row with
    // no credit — the poller finishes minutes later and the row would look
    // like a chat request that never billed. See project_video_generation.
    if (job?.requestLogId) {
      const submitRow = getRequestLog(job.requestLogId);
      const submitAt = submitRow?.createdAt ? new Date(submitRow.createdAt).getTime() : Date.now();
      updateRequestLog(job.requestLogId, {
        completionTokens: tokensCharge,
        creditUsed: result.credit ?? 0,
        durationMs: Date.now() - submitAt,
      });
      // Re-emit request_log so the Requests page live-updates the row in place.
      emit(EV_REQUEST_LOG, {
        id: job.requestLogId,
        provider: submitRow?.provider ?? "codebuddy",
        model: submitRow?.model ?? null,
        accountId: submitRow?.accountId ?? null,
        accountLabel: submitRow?.accountLabel ?? null,
        status: "success",
        httpStatus: 200,
        durationMs: Date.now() - submitAt,
        promptTokens: submitRow?.promptTokens ?? null,
        completionTokens: tokensCharge,
        creditUsed: result.credit ?? 0,
        errorMessage: null,
        attempts: [],
      });
    }
    emit(EV_VIDEO_STATUS, videoEventPayload(jobId));
  } catch (err) {
    console.warn(`[videoPoller] download #${jobId} failed:`, err instanceof Error ? err.message : err);
    // Don't mark failed on network blip — the URL is valid for ~12h, we'll
    // retry on the next tick.
    updateVideoJob(jobId, { videoUrl: url, updatedAt: new Date() });
  }
}

// Compact event payload: the dashboard already fetches the full row via API
// on click; the WS event just needs to be enough to update the table cell.
function videoEventPayload(jobId: number): Record<string, unknown> {
  const row = getVideoJob(jobId);
  if (!row) return { id: jobId, status: "unknown" };
  return {
    id: row.id,
    status: row.status,
    taskId: row.taskId,
    provider: row.provider,
    model: row.model,
    accountId: row.accountId,
    filePath: row.filePath,
    fileSize: row.fileSize,
    creditUsed: row.creditUsed,
    errorMessage: row.errorMessage,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

// Serialize a single tick — jobs are polled sequentially so we don't stampede
// the upstream (which already sees the CLI's identical 10 s polling cadence).
async function tick(): Promise<void> {
  const jobs = listPendingJobs();
  if (jobs.length === 0) return;
  for (const job of jobs) {
    try {
      await pollOnce(job);
    } catch (err) {
      console.error(`[videoPoller] tick job #${job.id} threw:`, err);
    }
  }
}

let started = false;

// Kick off the poller. Idempotent — repeat calls are no-ops so tests can
// import this module without spawning duplicate timers.
export function startVideoPoller(opts: { intervalMs?: number } = {}): void {
  if (started) return;
  started = true;
  ensureVideosDir();
  const intervalMs = opts.intervalMs ?? 10_000;
  const timer = setInterval(() => {
    tick().catch((err) => console.error("[videoPoller] tick threw:", err));
  }, intervalMs);
  // Unref so a lingering timer doesn't hold the process open in tests.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  // Kick immediately at boot so an orphaned job from the previous run gets
  // picked up without waiting a full interval.
  tick().catch((err) => console.error("[videoPoller] initial tick threw:", err));
}

// Exported for tests / manual poker.
export { tick as _tickVideoPoller };
