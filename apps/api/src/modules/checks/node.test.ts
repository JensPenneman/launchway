import { DEFAULT_APP_CHECKS_SETTINGS, generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { checkNodeOf } from './model.js';

describe('checkNodeOf', () => {
  const appNode = generateId('node');
  const other = generateId('node');

  it('is the node of the app unless the checks name another one', () => {
    expect(checkNodeOf({ nodeId: appNode, checks: DEFAULT_APP_CHECKS_SETTINGS })).toBe(appNode);
    expect(
      checkNodeOf({ nodeId: appNode, checks: { ...DEFAULT_APP_CHECKS_SETTINGS, nodeId: other } }),
    ).toBe(other);
  });

  it('treats settings stored before the field existed as the node of the app', () => {
    const { nodeId: _omitted, ...stored } = DEFAULT_APP_CHECKS_SETTINGS;
    expect(
      checkNodeOf({ nodeId: appNode, checks: stored as typeof DEFAULT_APP_CHECKS_SETTINGS }),
    ).toBe(appNode);
  });
});
