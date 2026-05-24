import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  FormGroup,
  Input,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from 'reactstrap';

export interface ConfirmOptions {
  title: string;
  body: string;
  okLabel?: string;
  okColor?: string;
  showSkipBackup?: boolean;
}

export interface ConfirmResult {
  confirmed: boolean;
  skipBackup?: boolean;
}

interface ConfirmContextValue {
  ask: (opts: ConfirmOptions) => Promise<ConfirmResult>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (result: ConfirmResult) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [skipBackup, setSkipBackup] = useState(false);
  // Guard against double-settle when reactstrap fires both onClosed and an
  // explicit button click in quick succession (we hit this with the old
  // <dialog> implementation too — same shape of bug, different host).
  const settledRef = useRef(false);

  const settle = useCallback(
    (result: ConfirmResult) => {
      if (settledRef.current || pending === null) return;
      settledRef.current = true;
      pending.resolve(result);
      setPending(null);
    },
    [pending],
  );

  const ask = useCallback((opts: ConfirmOptions): Promise<ConfirmResult> => {
    return new Promise<ConfirmResult>((resolve) => {
      settledRef.current = false;
      setSkipBackup(false);
      setPending({ opts, resolve });
    });
  }, []);

  const value = useMemo<ConfirmContextValue>(() => ({ ask }), [ask]);

  const opts = pending?.opts ?? null;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        isOpen={pending !== null}
        toggle={() => settle({ confirmed: false })}
        onClosed={() => settle({ confirmed: false })}
        centered
      >
        <ModalHeader toggle={() => settle({ confirmed: false })}>{opts?.title ?? ''}</ModalHeader>
        <ModalBody>
          <p className="mb-3">{opts?.body ?? ''}</p>
          {opts?.showSkipBackup === true ? (
            <FormGroup check>
              <Input
                type="checkbox"
                id="confirm-skip-backup"
                checked={skipBackup}
                onChange={(e) => setSkipBackup(e.target.checked)}
              />
              <Label for="confirm-skip-backup" check>
                Skip pre-switch backup
              </Label>
            </FormGroup>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button color="secondary" outline onClick={() => settle({ confirmed: false })}>
            Cancel
          </Button>
          <Button
            color={opts?.okColor ?? 'primary'}
            onClick={() =>
              settle({
                confirmed: true,
                skipBackup: opts?.showSkipBackup === true ? skipBackup : undefined,
              })
            }
          >
            {opts?.okLabel ?? 'OK'}
          </Button>
        </ModalFooter>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (ctx === null) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
