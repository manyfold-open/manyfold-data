/** Small browser hooks the pages share. */

import { useCallback, useSyncExternalStore } from 'react';

/** Whether a media query matches now, kept current. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** The phone layout: the width styles.css switches at. */
export const PHONE = '(max-width: 767px)';
export const useIsPhone = (): boolean => useMediaQuery(PHONE);

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
