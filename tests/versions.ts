// The X-Skill-Version an agent that read the current instructions sends back (src/worker/skill.ts):
// tests send it the way such an agent does. A test of what happens without it sets
// `x-no-skill-version`, and the header is left out.
import { findDataApp } from '../data-apps/index';
import { skillVersion } from '../src/worker/skill';
import type { Role } from '../src/worker/tokens';

/** `headers` with the version a maintainer sends on leases and verdicts, when `path` is one of those. */
export async function withMaintainerVersion(path: string, headers: Record<string, string>): Promise<Record<string, string>> {
  const match = /^\/api\/([^/?]+)\/(?:tasks|verdicts)(?:\?|$)/.exec(path);
  const config = match ? findDataApp(match[1]!) : undefined;
  if (!config || 'x-no-skill-version' in headers) return headers;
  return { ...headers, 'x-skill-version': await skillVersion(config, 'maintainer') };
}

/** The version a token of `role` sends for a data app. */
export async function versionOf(slug: string, role: Role): Promise<string> {
  return skillVersion(findDataApp(slug)!, role);
}
