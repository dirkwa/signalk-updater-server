import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Toast, ToastBody, ToastHeader } from 'reactstrap';

type ToastKind = 'info' | 'ok' | 'err';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);

  const show = useCallback((message: string, kind: ToastKind = 'info', durationMs = 4000) => {
    const id = nextId++;
    setEntries((prev) => [...prev, { id, message, kind, durationMs }]);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="position-fixed bottom-0 end-0 p-3"
        style={{ zIndex: 1080 }}
      >
        {entries.map((e) => (
          <ToastItem
            key={e.id}
            entry={e}
            onDismiss={() => setEntries((prev) => prev.filter((x) => x.id !== e.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, entry.durationMs);
    return () => clearTimeout(t);
  }, [entry.durationMs, onDismiss]);
  const headerLabel = entry.kind === 'err' ? 'Error' : entry.kind === 'ok' ? 'OK' : 'Info';
  const icon =
    entry.kind === 'err' ? 'bg-danger' : entry.kind === 'ok' ? 'bg-success' : 'bg-primary';
  return (
    <Toast isOpen className="mb-2">
      <ToastHeader
        icon={
          <span
            className={`d-inline-block rounded-circle ${icon}`}
            style={{ width: 10, height: 10 }}
          />
        }
        toggle={onDismiss}
      >
        {headerLabel}
      </ToastHeader>
      <ToastBody>{entry.message}</ToastBody>
    </Toast>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
