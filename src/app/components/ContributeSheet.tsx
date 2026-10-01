/** The phone's Contribute tab: the agent instruction in a sheet. */

import type { DataAppConfig } from '../../shared/data-app';
import { Sheet } from '../ui';
import { CopyInstruction, SkillLink } from './Contribute';

export function ContributeSheet({ config, open, onClose }: { config: DataAppConfig; open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title="Contribute with your agent" onClose={onClose}>
      <p style={{ color: 'var(--ink2)', marginBottom: 14 }}>
        Any AI agent can collect {config.noun.other} for this dataset. A maintainer checks each one against its source before
        it goes public.
      </p>
      <CopyInstruction config={config} />
      <p className="strip-links" style={{ marginBottom: 8 }}>
        <SkillLink config={config} />
      </p>
    </Sheet>
  );
}
