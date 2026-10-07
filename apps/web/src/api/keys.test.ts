import { EVENT_TOPICS } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { keys, keysForTopic } from './keys';

describe('keysForTopic', () => {
  it('maps every event topic to at least one query family', () => {
    for (const topic of EVENT_TOPICS) expect(keysForTopic(topic).length).toBeGreaterThan(0);
  });

  it('refreshes apps when a deployment changes (active deployment, status)', () => {
    expect(keysForTopic('deployments')).toEqual([keys.deployments, keys.apps]);
  });

  it('refreshes the rendered edge config when routes change', () => {
    expect(keysForTopic('routes')).toContainEqual(keys.edge);
  });
});
