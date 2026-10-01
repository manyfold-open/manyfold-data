/**
 * A bottom sheet for phones: filters, sort, contribute. It is a modal dialog without
 * <dialog>: focus moves in and stays in, Escape or the scrim closes it, and dragging the
 * handle down past 90px closes it too. Focus returns to whatever opened it.
 */

import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { prefersReducedMotion } from '../hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input, textarea, [tabindex]:not([tabindex="-1"])';
const CLOSE_MS = 300;

export function Sheet({
  open,
  title,
  onClose,
  action,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** A control at the right of the title row, e.g. Reset. */
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => {
      setMounted(false);
      opener.current?.focus({ preventScroll: true });
    }, prefersReducedMotion() ? 0 : CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [mounted]);

  useEffect(() => {
    if (shown) (sheet.current?.querySelector<HTMLElement>(FOCUSABLE) ?? sheet.current)?.focus({ preventScroll: true });
  }, [shown]);

  if (!mounted) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !sheet.current) return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a')) return;
    drag.current = { y: event.clientY, dy: 0 };
    sheet.current?.classList.add('dragging');
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.y);
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const endDrag = () => {
    if (!drag.current || !sheet.current) return;
    const far = drag.current.dy > 90;
    drag.current = null;
    sheet.current.classList.remove('dragging');
    sheet.current.style.transform = '';
    if (far) onClose();
  };

  return createPortal(
    <div className={shown ? 'sheet-layer open' : 'sheet-layer'} onKeyDown={onKeyDown}>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="sheet-grab" aria-hidden="true">
            <i />
          </div>
          <div className="sheet-head">
            <h2 id={titleId}>{title}</h2>
            {action ?? (
              <button type="button" className="link-button" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
