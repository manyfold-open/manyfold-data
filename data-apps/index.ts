/**
 * Every data app on data.manyfold.ai. Adding one = a config folder here plus a line
 * below; pages, the read API and validation pick it up from this list.
 */

import type { DataAppConfig } from '../src/shared/data-app.ts';
import aiAccelerators from './ai-accelerators/config.ts';
import aiAcquisitions from './ai-acquisitions/config.ts';
import aiConferences from './ai-conferences/config.ts';
import aiDataCenters from './ai-data-centers/config.ts';
import aiFundraising from './ai-fundraising/config.ts';
import aiHackathons from './ai-hackathons/config.ts';
import marathons from './marathons/config.ts';

export const dataApps: readonly DataAppConfig[] = [
  aiHackathons,
  aiAccelerators,
  aiConferences,
  aiFundraising,
  aiAcquisitions,
  aiDataCenters,
  marathons,
];

export const findDataApp = (slug: string): DataAppConfig | undefined =>
  dataApps.find((app) => app.slug === slug);
