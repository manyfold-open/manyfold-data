// Types for workerd.mjs (see there for why it is JavaScript).
export function openWorkerdD1(): Promise<{ db: D1Database; close: () => Promise<void> }>;
