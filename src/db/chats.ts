// DB access for AI Chat sessions. List rows exclude the messages blob so the
// sidebar stays light; the full row (with blob) is fetched per session.

import { desc, eq } from "drizzle-orm";
import { db } from "./index";
import { chatSessions } from "./schema";

export interface ChatSessionRow {
  id: number;
  title: string;
  model: string;
  messages: string;
  msgCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatSessionListRow {
  id: number;
  title: string;
  model: string;
  msgCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function listChatSessions(): ChatSessionListRow[] {
  return db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      model: chatSessions.model,
      msgCount: chatSessions.msgCount,
      createdAt: chatSessions.createdAt,
      updatedAt: chatSessions.updatedAt,
    })
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt))
    .all();
}

export function getChatSession(id: number): ChatSessionRow | undefined {
  return db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
}

export function createChatSession(row: { title?: string; model?: string }): number {
  return db
    .insert(chatSessions)
    .values({
      title: row.title ?? "New chat",
      model: row.model ?? "",
    })
    .returning({ id: chatSessions.id })
    .get().id;
}

export function updateChatSession(
  id: number,
  row: { title?: string; model?: string; messages?: string; msgCount?: number }
): boolean {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (row.title !== undefined) patch.title = row.title;
  if (row.model !== undefined) patch.model = row.model;
  if (row.messages !== undefined) patch.messages = row.messages;
  if (row.msgCount !== undefined) patch.msgCount = row.msgCount;
  return (
    db.update(chatSessions).set(patch).where(eq(chatSessions.id, id)).returning({ id: chatSessions.id }).get() !==
    undefined
  );
}

export function deleteChatSession(id: number): boolean {
  return db.delete(chatSessions).where(eq(chatSessions.id, id)).returning({ id: chatSessions.id }).get() !== undefined;
}
