// Self-clearing timed message — success toasts and the like.

import { useCallback, useRef, useState } from "react";

type TimerHandle = ReturnType<typeof setTimeout>;

export function useTimedMessage<T>(initial: T, ms = 4000) {
  const [message, setMessage] = useState<T>(initial);
  const timer = useRef<TimerHandle | null>(null);

  const set = useCallback(
    (value: T) => {
      clearTimeout(timer.current ?? undefined);
      setMessage(value);
      timer.current = setTimeout(() => setMessage(initial), ms);
    },
    [initial, ms]
  );

  const clearMessage = useCallback(() => {
    clearTimeout(timer.current ?? undefined);
    setMessage(initial);
  }, [initial]);

  return { message, setMessage: set, clearMessage };
}
