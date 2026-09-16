// Video job CRUD. Rows are created at /v1/videos/generations submit time,
// updated by the background poller as the upstream task progresses, and read
// by /v1/videos/:id (status) and /v1/videos/:id/download (file bytes).

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { videoJobs } from "./schema";

export interface VideoJobParams {
  prompt: string;
  seconds: number;
  resolution: "720P" | "1080P";
  aspectRatio: "16:9" | "9:16" | "1:1";
  audio: boolean;
  negativePrompt: string;
  watermark: boolean;
}

export interface VideoJobRow {
  id: number;
  provider: string;
  model: string;
  accountId: number;
  accountLabel: string | null;
  apiKeyId: number | null;
  taskId: string;
  status: string;
  params: VideoJobParams;
  filePath: string | null;
  fileSize: number | null;
  videoUrl: string | null;
  creditUsed: number | null;
  dollarCost: number | null;
  errorMessage: string | null;
  requestLogId: number | null;
  createdAt: Date;
  updatedAt: Date | null;
  completedAt: Date | null;
}

export function listVideoJobs(opts: { status?: string; limit?: number } = {}): VideoJobRow[] {
  const limit = opts.limit ?? 200;
  const q = db.select().from(videoJobs).orderBy(desc(videoJobs.createdAt)).limit(limit);
  if (opts.status) {
    return db
      .select()
      .from(videoJobs)
      .where(eq(videoJobs.status, opts.status))
      .orderBy(desc(videoJobs.createdAt))
      .limit(limit)
      .all() as VideoJobRow[];
  }
  return q.all() as VideoJobRow[];
}

export function getVideoJob(id: number): VideoJobRow | undefined {
  return db.select().from(videoJobs).where(eq(videoJobs.id, id)).get() as VideoJobRow | undefined;
}

export function getVideoJobByTaskId(taskId: string): VideoJobRow | undefined {
  return db.select().from(videoJobs).where(eq(videoJobs.taskId, taskId)).get() as VideoJobRow | undefined;
}

// Jobs the background poller should re-check. `queued` and `in_progress` are
// upstream-live states; `completed` and `failed` are terminal.
export function listPendingJobs(): VideoJobRow[] {
  return db
    .select()
    .from(videoJobs)
    .where(inArray(videoJobs.status, ["queued", "in_progress"]))
    .orderBy(asc(videoJobs.createdAt))
    .all() as VideoJobRow[];
}

export function createVideoJob(row: {
  provider: string;
  model: string;
  accountId: number;
  accountLabel?: string | null;
  apiKeyId?: number | null;
  taskId: string;
  status?: string;
  params: VideoJobParams;
  requestLogId?: number | null;
}): number {
  return db
    .insert(videoJobs)
    .values({
      provider: row.provider,
      model: row.model,
      accountId: row.accountId,
      accountLabel: row.accountLabel ?? null,
      apiKeyId: row.apiKeyId ?? null,
      taskId: row.taskId,
      status: row.status ?? "queued",
      params: row.params,
      requestLogId: row.requestLogId ?? null,
    })
    .returning({ id: videoJobs.id })
    .get().id;
}

export function updateVideoJob(
  id: number,
  patch: Partial<
    Pick<
      VideoJobRow,
      | "status"
      | "filePath"
      | "fileSize"
      | "videoUrl"
      | "creditUsed"
      | "dollarCost"
      | "errorMessage"
      | "requestLogId"
      | "updatedAt"
      | "completedAt"
    >
  >
): boolean {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.filePath !== undefined) set.filePath = patch.filePath;
  if (patch.fileSize !== undefined) set.fileSize = patch.fileSize;
  if (patch.videoUrl !== undefined) set.videoUrl = patch.videoUrl;
  if (patch.creditUsed !== undefined) set.creditUsed = patch.creditUsed;
  if (patch.dollarCost !== undefined) set.dollarCost = patch.dollarCost;
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
  if (patch.requestLogId !== undefined) set.requestLogId = patch.requestLogId;
  if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  if (Object.keys(set).length === 0) return false;
  // Always stamp updatedAt so the dashboard can sort by activity even when
  // the caller forgot to set it.
  if (set.updatedAt === undefined) set.updatedAt = new Date();
  const r = db
    .update(videoJobs)
    .set(set)
    .where(eq(videoJobs.id, id))
    .returning({ id: videoJobs.id })
    .get();
  return r !== undefined;
}

// Success shortcut. Sets the terminal fields together with completedAt so a
// half-updated row can't linger in "completed but no file" state.
export function markCompleted(
  id: number,
  patch: {
    filePath: string;
    fileSize: number;
    videoUrl: string;
    creditUsed: number;
    dollarCost: number | null;
  }
): void {
  const now = new Date();
  db.update(videoJobs)
    .set({
      status: "completed",
      filePath: patch.filePath,
      fileSize: patch.fileSize,
      videoUrl: patch.videoUrl,
      creditUsed: patch.creditUsed,
      dollarCost: patch.dollarCost,
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(videoJobs.id, id))
    .run();
}

export function markFailed(id: number, errorMessage: string): void {
  const now = new Date();
  db.update(videoJobs)
    .set({
      status: "failed",
      errorMessage,
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(videoJobs.id, id))
    .run();
}

export function deleteVideoJob(id: number): VideoJobRow | undefined {
  return db.delete(videoJobs).where(eq(videoJobs.id, id)).returning().get() as VideoJobRow | undefined;
}

export function countVideoJobs(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(videoJobs).get();
  return row?.n ?? 0;
}
