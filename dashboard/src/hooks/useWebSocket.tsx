// Shared WebSocket connection for the whole app. Pages subscribe to event
// types via useWsEvent instead of each opening their own socket — one
// auto-reconnecting connection fans every server event out to handlers.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type WsStatus = "connecting" | "open" | "closed";

export interface WsMessage {
  type: string;
  data: unknown;
}

type Handler = (msg: WsMessage) => void;

interface WsContextValue {
  status: WsStatus;
  subscribe: (types: string[], handler: Handler) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const handlers = useRef(new Set<{ types: string[]; handler: Handler }>());
  const backoff = useRef(BASE_BACKOFF_MS);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (stopped) return;
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      socket.current = ws;

      ws.onopen = () => {
        backoff.current = BASE_BACKOFF_MS;
        setStatus("open");
      };
      ws.onmessage = (evt) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(String(evt.data)) as WsMessage;
        } catch {
          return;
        }
        for (const { types, handler } of handlers.current) {
          if (types.includes(msg.type)) {
            try {
              handler(msg);
            } catch {
              // A throwing page handler must not starve the others.
            }
          }
        }
      };
      ws.onclose = () => {
        socket.current = null;
        setStatus("closed");
        if (stopped) return;
        timer = setTimeout(connect, backoff.current);
        backoff.current = Math.min(backoff.current * 2, MAX_BACKOFF_MS);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  const subscribe = useCallback((types: string[], handler: Handler) => {
    const entry = { types, handler };
    handlers.current.add(entry);
    return () => {
      handlers.current.delete(entry);
    };
  }, []);

  return <WsContext.Provider value={{ status, subscribe }}>{children}</WsContext.Provider>;
}

export function useWsStatus(): WsStatus {
  const ctx = useContext(WsContext);
  return ctx?.status ?? "closed";
}

// Subscribe to one or more server event types. The handler identity is kept
// in a ref, so inline closures are fine and never re-subscribe.
export function useWsEvent(type: string | string[], handler: Handler): void {
  const ctx = useContext(WsContext);
  const ref = useRef(handler);
  ref.current = handler;
  const types = Array.isArray(type) ? type : [type];
  const key = types.join(",");
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(key.split(","), (msg) => ref.current(msg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key]);
}
