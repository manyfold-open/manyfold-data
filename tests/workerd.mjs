// D1 as production runs it: workerd's own SQLite through wrangler's getPlatformProxy, in memory.
// It reports rows read the way D1 bills them, which the node:sqlite double (d1.ts) cannot.
// Plain JavaScript, so the type check never loads wrangler's types; workerd.d.mts declares it.
import { getPlatformProxy } from 'wrangler';

export async function openWorkerdD1() {
  const platform = await getPlatformProxy({ persist: false });
  return { db: platform.env.DB, close: () => platform.dispose() };
}
