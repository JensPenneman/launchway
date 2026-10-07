import { EVENT_TOPICS } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { keys, keysForTopic } from './keys';

describe('keysForTopic', () => {
  it('maps every event topic to at least one query family', () => {
    for (const topic of EVENT_TOPICS) expect(keysForTopic(topic).length).toBeGreaterThan(0);
  });

  it('refreshes apps and previews when a deployment changes (active deployment, status)', () => {
    expect(keysForTopic('deployments')).toEqual([keys.deployments, keys.apps, keys.previews]);
  });

  it('refreshes previews with their deployments, domains and routes', () => {
    expect(keysForTopic('previews')).toEqual(
      expect.arrayContaining([keys.previews, keys.deployments, keys.domains, keys.routes]),
    );
  });

  it('refreshes the rendered edge config when routes change', () => {
    expect(keysForTopic('routes')).toContainEqual(keys.edge);
  });
});
