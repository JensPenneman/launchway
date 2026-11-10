import { describe, expect, it } from 'vitest';
import { sweepWarning } from './automation-sweep';

describe('sweepWarning', () => {
  it('names the pull requests whose auto-merge may still be on', () => {
    expect(sweepWarning({ sweep: { confirmed: [3], failed: [12, 15] } })).toBe(
      'Auto-merge may still be on for #12, #15; Launchway keeps trying',
    );
    expect(sweepWarning({ sweep: { confirmed: [], failed: [12] } })).toContain('#12');
  });

  it('says nothing when every disable was confirmed or no sweep ran', () => {
    expect(sweepWarning({ sweep: { confirmed: [3], failed: [] } })).toBeNull();
    expect(sweepWarning({ sweep: null })).toBeNull();
  });
});
