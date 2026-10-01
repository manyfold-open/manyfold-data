/** A short confirmation at the bottom of the screen: "Copied". One at a time. */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const ToastContext = createContext<(message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setMessage({ text, id: Date.now() });
    timer.current = setTimeout(() => setMessage(null), 1800);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">
        {message ? (
          <div key={message.id} className="toast" role="status">
            {message.text}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = (): ((message: string) => void) => useContext(ToastContext);
