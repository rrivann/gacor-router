// Server-side event bus: publishers emit typed events, WebSocket clients at
// /ws receive them all as JSON. Deliberately tiny — single process, single
// user, so a Set of subscribers is the whole implementation. Events that
// nobody is subscribed to are dropped (fire-and-forget), matching the
// firehose semantics of the dashboard live feed.

export interface BusEvent {
  type: string;
  data: unknown;
}

type Listener = (event: BusEvent) => void;

const listeners = new Set<Listener>();

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(type: string, data: unknown): void {
  if (listeners.size === 0) return;
  const event: BusEvent = { type, data };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A throwing listener must not take the others down with it.
    }
  }
}

// Event types emitted today (kept as constants for the dashboard's useWsEvent):
//   request_log      — a proxied request finished (success or error)
//   account_status   — an account's status changed (active/exhausted/banned)
//   video_status     — a video job transitioned (queued/in_progress/completed/failed)
//   console_log      — a new stdout/stderr line was captured (or buffer cleared)
export const EV_REQUEST_LOG = "request_log";
export const EV_ACCOUNT_STATUS = "account_status";
export const EV_VIDEO_STATUS = "video_status";
export const EV_CONSOLE_LOG = "console_log";
