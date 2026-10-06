import { describe, expect, it } from 'vitest';
import {
  AppSlug,
  CreateAppInput,
  composeProjectName,
  maskEnvVar,
  resolveAppSource,
  SetEnvVarsInput,
  serviceAlias,
  UpdateAppInput,
  UpdateEnvVarInput,
} from './apps.js';
import { GitRef, RelativePath } from './common.js';
import { generateId } from './ids.js';

const base = {
  name: 'Trail',
  connectionId: generateId('gh'),
  repository: { owner: 'jenspenneman', name: 'trail' },
  nodeId: generateId('node'),
};

describe('app source', () => {
  it('defaults to compose.yaml when neither compose files nor a Dockerfile are given', () => {
    const input = CreateAppInput.parse(base);
    expect(input.autoDeployReleases).toBe(false);
    expect(resolveAppSource(input)).toEqual({ kind: 'compose', composeFiles: ['compose.yaml'] });
  });

  it('accepts a Dockerfile with the default context', () => {
    const input = CreateAppInput.parse({ ...base, dockerfile: 'Dockerfile' });
    expect(resolveAppSource(input)).toEqual({
      kind: 'dockerfile',
      dockerfile: 'Dockerfile',
      context: '.',
    });
  });

  it('rejects composeFiles together with a Dockerfile, and context without a Dockerfile', () => {
    expect(
      CreateAppInput.safeParse({
        ...base,
        composeFiles: ['compose.yaml'],
        dockerfile: 'Dockerfile',
      }).success,
    ).toBe(false);
    expect(CreateAppInput.safeParse({ ...base, context: 'app' }).success).toBe(false);
    expect(
      UpdateAppInput.safeParse({ composeFiles: ['a.yaml'], dockerfile: 'Dockerfile' }).success,
    ).toBe(false);
    expect(UpdateAppInput.safeParse({}).success).toBe(false);
  });

  it('only accepts relative paths inside the repository', () => {
    for (const ok of ['compose.yaml', 'deploy/compose.prod.yaml', '.', 'docker/Dockerfile']) {
      expect(RelativePath.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['/etc/passwd', '../compose.yaml', 'a/../../b', 'a/..', '-f', 'a b', '']) {
      expect(RelativePath.safeParse(bad).success).toBe(false);
    }
  });
});

describe('naming', () => {
  it('derives compose project names and aliases', () => {
    expect(composeProjectName('trail')).toBe('slipway-trail');
    expect(serviceAlias('trail', 'web')).toBe('trail-web');
    expect(() => serviceAlias('a'.repeat(40), 'b'.repeat(30))).toThrow(RangeError);
  });

  it('validates slugs and reserves platform names', () => {
    expect(AppSlug.safeParse('trail-2').success).toBe(true);
    for (const bad of ['Trail', '-trail', 'trail-', 'slipway', 'caddy', 'a'.repeat(41), 'tr_ail']) {
      expect(AppSlug.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts refs from the spec pattern only', () => {
    for (const ok of ['v1.2.3', 'main', 'feature/x', '3f786850e387550fdab836ed7e6dc881de23001b']) {
      expect(GitRef.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['-rf', '--upload-pack=x', 'a..b', 'v1 2', 'tag;rm', '']) {
      expect(GitRef.safeParse(bad).success).toBe(false);
    }
  });
});

describe('environment variables', () => {
  const now = '2026-10-06T12:00:00.000Z';
  const variable = { id: generateId('env'), key: 'API_KEY', createdAt: now, updatedAt: now };

  it('masks secret values and returns plain ones', () => {
    expect(maskEnvVar({ ...variable, secret: true, value: 'hunter2' }).value).toBeNull();
    expect(maskEnvVar({ ...variable, secret: false, value: 'debug' }).value).toBe('debug');
  });

  it('never leaks the secret through other fields', () => {
    const masked = maskEnvVar({ ...variable, secret: true, value: 'hunter2' });
    expect(JSON.stringify(masked)).not.toContain('hunter2');
  });

  it('requires a new value when a secret becomes a plain variable', () => {
    expect(UpdateEnvVarInput.safeParse({ secret: false }).success).toBe(false);
    expect(UpdateEnvVarInput.safeParse({ secret: false, value: 'x' }).success).toBe(true);
    expect(UpdateEnvVarInput.safeParse({ secret: true }).success).toBe(true);
  });

  it('rejects duplicate keys and invalid key names in bulk updates', () => {
    expect(SetEnvVarsInput.safeParse({ variables: [{ key: 'A' }, { key: 'A' }] }).success).toBe(
      false,
    );
    expect(SetEnvVarsInput.safeParse({ variables: [{ key: '1A', value: 'x' }] }).success).toBe(
      false,
    );
    expect(
      SetEnvVarsInput.parse({ variables: [{ key: 'A_1', value: 'x' }] }).variables[0]?.secret,
    ).toBe(false);
  });
});
