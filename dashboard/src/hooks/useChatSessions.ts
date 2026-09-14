// Shared AI-Chat sessions store (enowx-derived, slimmed). The server is the
// source of truth (SQLite via /api/chat/sessions); this cache holds the
// lightweight list rows and notifies subscribers on mutation. The active id
// is a UI preference persisted in localStorage.

import { useEffect, useState } from "react";
import {
  createChatSession,
  deleteChatSession,
  fetchChatSession,
  fetchChatSessions,
  updateChatSession,
  type ChatSessionListRow,
  type ChatSessionRow,
} from "../lib/api";

let cache: ChatSessionListRow[] | null = null;
const listeners = new Set<(rows: ChatSessionListRow[] | null) => void>();

const ACTIVE_KEY = "gacor.chat-active";
function readActive(): number | null {
  try {
    const v = localStorage.getItem(ACTIVE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}
function writeActive(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, String(id));
  } catch {}
}

function emit() {
  for (const l of listeners) l(cache);
}

export async function reloadSessions(): Promise<ChatSessionListRow[]> {
  try {
    cache = (await fetchChatSessions()).sessions ?? [];
  } catch {
    cache = cache ?? [];
  }
  emit();
  return cache ?? [];
}

export function deriveTitle(firstUserText: string): string {
  const t = firstUserText.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 48 ? t.slice(0, 48) + "…" : t;
}

export function useChatSessions() {
  const [sessions, setSessions] = useState<ChatSessionListRow[] | null>(cache);
  const [activeId, setActiveIdState] = useState<number | null>(readActive());

  useEffect(() => {
    listeners.add(setSessions);
    if (cache === null) reloadSessions();
    else setSessions(cache);
    return () => {
      listeners.delete(setSessions);
    };
  }, []);

  const setActive = (id: number | null) => {
    writeActive(id);
    setActiveIdState(id);
  };

  return {
    sessions,
    activeId,
    setActive,
    reload: reloadSessions,

    create: async (model: string) => {
      const { id } = await createChatSession({ title: "New chat", model });
      await reloadSessions();
      setActive(id);
      return id;
    },

    save: async (id: number, title: string, model: string, messages: string, msgCount: number) => {
      await updateChatSession(id, { title, model, messages, msgCount });
      await reloadSessions();
    },

    remove: async (id: number) => {
      await deleteChatSession(id);
      if (readActive() === id) setActive(null);
      await reloadSessions();
    },

    load: (id: number): Promise<ChatSessionRow> => fetchChatSession(id),
  };
}
