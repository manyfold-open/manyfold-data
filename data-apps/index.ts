/**
 * Every data app on data.manyfold.ai. Adding one = a config folder here plus a line
 * below; pages, the read API and validation pick it up from this list.
 */

import type { DataAppConfig } from '../src/shared/data-app.ts';
import aiHackathons from './ai-hackathons/config.ts';

export const dataApps: readonly DataAppConfig[] = [aiHackathons];

export const findDataApp = (slug: string): DataAppConfig | undefined =>
  dataApps.find((app) => app.slug === slug);
