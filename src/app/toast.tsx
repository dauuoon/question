"use client";

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";

type Notice = { message: string; error: boolean; action?: ReactNode; onDismiss?: () => void; exiting?: boolean; persistent?: boolean };
type ToastRegistry = { put: (id: string, notice: Notice) => void; remove: (id: string) => void };
const Registry = createContext<ToastRegistry | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const registry = useMemo<ToastRegistry>(() => ({
    put: (id, notice) => setNotices((current) => ({ ...current, [id]: notice })),
    remove: (id) => setNotices((current) => current[id] ?
      { ...current, [id]: { ...current[id], exiting: true } } : current),
  }), []);
  function finish(id: string) {
    setNotices((current) => {
      if (!current[id]?.exiting) return current;
      const next = { ...current }; delete next[id]; return next;
    });
  }
  return <Registry.Provider value={registry}>
    {children}
    <div className="toast-stack" aria-label="알림">
      {Object.entries(notices).map(([id, notice]) =>
        <ToastBox key={id} notice={notice} finish={() => finish(id)} />)}
    </div>
  </Registry.Provider>;
}

function ToastBox({ notice, finish }: { notice: Notice; finish: () => void }) {
  useEffect(() => {
    if (!notice.exiting) return;
    const timer = setTimeout(finish, 240);
    return () => clearTimeout(timer);
  }, [notice.exiting, finish]);
  return <div className={`toast-box${notice.error ? " toast-error" : ""}${notice.exiting ? " is-exiting" : ""}`}
    role={notice.error ? "alert" : "status"}>
    <p>{notice.message}</p>
    {notice.action ? <div className="toast-actions">{notice.action}</div> : null}
  </div>;
}

export function Toast({ message, error = false, action, onDismiss, persistent = false }: Notice) {
  const registry = useContext(Registry);
  const id = useId();
  useEffect(() => {
    if (!registry || !message) return;
    registry.put(id, { message, error, action, onDismiss });
    const timer = !action && !persistent ? setTimeout(() => registry.remove(id), error ? 8000 : 6000) : null;
    return () => { if (timer) clearTimeout(timer); registry.remove(id); };
  }, [registry, id, message, error, action, onDismiss, persistent]);
  return null;
}
