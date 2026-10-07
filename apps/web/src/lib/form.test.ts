import { Email, Password, z } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { zodResolver } from './form';

const Schema = z.object({
  email: Email,
  password: Password,
  name: z.string().regex(/^a/, 'Starts with a'),
});
const resolve = zodResolver(Schema);

async function run(values: z.input<typeof Schema>) {
  return resolve(values, undefined, { fields: {}, shouldUseNativeValidation: false });
}

describe('zodResolver', () => {
  it('returns parsed values when valid', async () => {
    const result = await run({ email: 'Ops@Example.com', password: 'x'.repeat(12), name: 'ab' });
    expect(result.values).toEqual({
      email: 'ops@example.com',
      password: 'x'.repeat(12),
      name: 'ab',
    });
  });

  it('reports friendly messages and keeps schema-specific ones', async () => {
    const result = await run({ email: 'nope', password: 'short', name: 'b' });
    expect(result.errors.email?.message).toBe('Enter a valid e-mail address');
    expect(result.errors.password?.message).toBe('Must be at least 12 characters');
    expect(result.errors.name?.message).toBe('Starts with a');
  });
});
