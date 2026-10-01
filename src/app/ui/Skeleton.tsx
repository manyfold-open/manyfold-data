/**
 * Loading placeholders. A skeleton takes the final layout's space at once, so nothing moves
 * when the data lands (CLS 0); it only becomes visible after 150ms, and once visible it
 * stays at least 300ms, so a fast answer never flickers.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

export const SHOW_AFTER_MS = 150;
export const SHOW_AT_LEAST_MS = 300;

export function Skeleton({ width = '100%', height, round, style }: { width?: string | number; height: number; round?: boolean; style?: CSSProperties }) {
  return <div className="sk" aria-hidden="true" style={{ width, height, borderRadius: round ? '50%' : undefined, ...style }} />;
}

/**
 * Whether to keep the skeleton in place (`pending`) and whether it shimmers (`visible`).
 * Pass true while the first answer is out.
 */
export function usePending(loading: boolean): { pending: boolean; visible: boolean } {
  const [visible, setVisible] = useState(false);
  const since = useRef(0);

  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => {
        since.current = Date.now();
        setVisible(true);
      }, SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), Math.max(0, SHOW_AT_LEAST_MS - (Date.now() - since.current)));
    return () => clearTimeout(timer);
  }, [loading, visible]);

  return { pending: loading || visible, visible };
}
