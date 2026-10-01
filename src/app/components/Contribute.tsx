/**
 * How a reader adds to a data app: the one sentence an owner hands their agent, with the
 * skill it points to. Shown as a strip on the Overview and in the phone's Contribute sheet.
 */

import { useState } from 'react';
import type { DataAppConfig } from '../../shared/data-app';
import { track } from '../analytics';
import { Button, useToast } from '../ui';

export function instructionFor(config: DataAppConfig): { skillUrl: string; instruction: string } {
  const skillUrl = `${location.origin}/${config.slug}/SKILL.md`;
  return { skillUrl, instruction: `Read ${skillUrl} and contribute to ${config.title} as a collector.` };
}

export function CopyInstruction({ config }: { config: DataAppConfig }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const { instruction } = instructionFor(config);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(instruction);
      track('agent_instruction_copied', { data_app: config.slug });
      setCopied(true);
      toast('Instruction copied');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked: the sentence is on screen to select by hand.
      toast('Select the text to copy it');
    }
  };

  return (
    <div className="instruction">
      <code>{instruction}</code>
      <Button variant="primary" icon={copied ? 'check' : undefined} className={copied ? 'done' : undefined} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function SkillLink({ config }: { config: DataAppConfig }) {
  return (
    <a href={instructionFor(config).skillUrl} onClick={() => track('skill_opened', { data_app: config.slug })}>
      Read the skill
    </a>
  );
}

export function ContributeStrip({ config }: { config: DataAppConfig }) {
  return (
    <section className="strip" aria-labelledby="contribute-heading">
      <div>
        <h2 id="contribute-heading">Contribute with your agent</h2>
        <p>
          Any AI agent can collect {config.noun.other} for this dataset. New records stay private until a maintainer checks
          them against their source.
        </p>
        <div className="strip-links">
          <SkillLink config={config} />
        </div>
      </div>
      <CopyInstruction config={config} />
    </section>
  );
}

/** Where readers get each new record as it is verified: the data app's Discord channel, or the feed. */
export function FollowStrip({ config, invite }: { config: DataAppConfig; invite: string }) {
  return (
    <section className="strip single" aria-labelledby="follow-heading">
      <div>
        <h2 id="follow-heading">Get new {config.noun.other} as they are verified</h2>
        <p>
          Every {config.noun.one} a maintainer verifies is posted to the {config.title} channel on Discord within minutes, or
          follow the{' '}
          <a href={`/${config.slug}/feed.xml`} onClick={() => track('data_exported', { data_app: config.slug, format: 'rss' })}>
            RSS feed
          </a>
          .
        </p>
      </div>
      <a
        className="btn secondary"
        href={invite}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track('discord_joined', { data_app: config.slug, placement: 'follow' })}
      >
        Join the channel
      </a>
    </section>
  );
}
