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
import aiScams from './ai-scams/config.ts';
import enduranceRaces from './endurance-races/config.ts';
import marathons from './marathons/config.ts';
import newRules from './new-rules/config.ts';
import oncologyDrugUpdates from './oncology-drug-updates/config.ts';
import recalls from './recalls/config.ts';
import robotLaunches from './robot-launches/config.ts';
import robotaxis from './robotaxis/config.ts';
import scholarships from './scholarships/config.ts';
import skyEvents from './sky-events/config.ts';
import visaChanges from './visa-changes/config.ts';

export const dataApps: readonly DataAppConfig[] = [
  aiHackathons,
  aiAccelerators,
  aiConferences,
  aiFundraising,
  aiAcquisitions,
  aiDataCenters,
  robotaxis,
  robotLaunches,
  aiScams,
  visaChanges,
  newRules,
  recalls,
  scholarships,
  marathons,
  enduranceRaces,
  skyEvents,
  oncologyDrugUpdates,
];

export const findDataApp = (slug: string): DataAppConfig | undefined =>
  dataApps.find((app) => app.slug === slug);
