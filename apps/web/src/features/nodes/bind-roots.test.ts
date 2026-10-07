import { describe, expect, it } from 'vitest';
import { bindRootsError, parseBindRoots } from './bind-roots';

describe('bind roots input', () => {
  it('reads one root per line and ignores blank lines', () => {
    expect(parseBindRoots(' /srv/data \n\n/run/desktop/mnt/host/d/Backups\n')).toEqual([
      '/srv/data',
      '/run/desktop/mnt/host/d/Backups',
    ]);
  });

  it('names the offending line', () => {
    expect(bindRootsError(['/srv/data'])).toBeUndefined();
    expect(bindRootsError(['/srv/data', 'backups'])).toBe(
      'backups: Must be an absolute path (start with /)',
    );
    expect(bindRootsError(['/'])).toMatch(/^\/: The root directory/);
    expect(bindRootsError(['/a', '/a'])).toBe('Roots must be unique');
  });
});
