import { describe, expect, it } from 'vitest';
import {
  AppPreviewSettings,
  composeProjectName,
  DEFAULT_APP_PREVIEW_SETTINGS,
  PreviewEnvOverrides,
  PreviewHostTemplate,
  previewSlug,
  serviceAlias,
  UpdateAppInput,
} from './apps.js';
import { EnvironmentName, previewEnvironmentName } from './deployments.js';
import { generateId } from './ids.js';
import {
  previewAgentAppId,
  previewSlugFits,
  renderPreviewEnvOverrides,
  renderPreviewHost,
} from './previews.js';

describe('preview naming', () => {
  it('extends the project name and aliases with the pull request number', () => {
    expect(previewSlug('trail', 7)).toBe('trail-pr-7');
    expect(composeProjectName('trail')).toBe('launchway-trail');
    expect(composeProjectName('trail', 7)).toBe('launchway-trail-pr-7');
    expect(serviceAlias('trail', 'web')).toBe('trail-web');
    expect(serviceAlias('trail', 'web', 7)).toBe('trail-pr-7-web');
    // The agent derives both from the slug it receives.
    expect(composeProjectName(previewSlug('trail', 7))).toBe(composeProjectName('trail', 7));
  });

  it('refuses aliases beyond 63 characters', () => {
    expect(() => serviceAlias('a'.repeat(40), 'b'.repeat(20), 123)).toThrow(RangeError);
  });

  it('checks that the preview slug fits the 40-character slug', () => {
    expect(previewSlugFits('a'.repeat(34), 9)).toBe(true);
    expect(previewSlugFits('a'.repeat(34), 99)).toBe(true);
    expect(previewSlugFits('a'.repeat(35), 99)).toBe(false);
  });

  it('names environments', () => {
    expect(previewEnvironmentName(12)).toBe('preview/pr-12');
    expect(EnvironmentName.safeParse('production').success).toBe(true);
    expect(EnvironmentName.safeParse('preview/pr-12').success).toBe(true);
    expect(EnvironmentName.safeParse('preview/pr-0').success).toBe(false);
    expect(EnvironmentName.safeParse('staging').success).toBe(false);
  });

  it('gives the agent an app id that keeps the preview id suffix', () => {
    const id = generateId('prv');
    const agentId = previewAgentAppId(id);
    expect(agentId).toMatch(/^app_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    expect(agentId.slice(4)).toBe(id.slice(4));
  });
});

describe('preview host templates', () => {
  it('renders the default template', () => {
    expect(
      renderPreviewHost(DEFAULT_APP_PREVIEW_SETTINGS.hostTemplate, {
        slug: 'trail',
        number: 42,
        base: 'preview.example.com',
      }),
    ).toBe('trail-pr-42.preview.example.com');
  });

  it('renders custom templates and rejects invalid results', () => {
    expect(
      renderPreviewHost('pr{number}.{slug}.{base}', { slug: 'trail', number: 3, base: 'x.dev' }),
    ).toBe('pr3.trail.x.dev');
    expect(() =>
      renderPreviewHost('{slug}-{number}.{base}', {
        slug: 'a'.repeat(70),
        number: 3,
        base: 'x.dev',
      }),
    ).toThrow(RangeError);
  });

  it('validates templates', () => {
    expect(PreviewHostTemplate.parse('PR-{number}.{base}')).toBe('pr-{number}.{base}');
    expect(PreviewHostTemplate.safeParse('{slug}.{base}').success).toBe(false);
    expect(PreviewHostTemplate.safeParse('{slug}-{number}.example.com').success).toBe(false);
    expect(PreviewHostTemplate.safeParse('{slug}-{branch}-{number}.{base}').success).toBe(false);
    expect(PreviewHostTemplate.safeParse('{slug} {number}.{base}').success).toBe(false);
  });
});

describe('preview environment overrides', () => {
  const values = {
    previewUrl: 'https://trail-pr-4.preview.example.com',
    previewHost: 'trail-pr-4.preview.example.com',
    prNumber: 4,
    branch: 'feat/x',
    sha: 'f'.repeat(40),
  };

  it('fills every placeholder, with or without spaces', () => {
    expect(
      renderPreviewEnvOverrides(
        {
          URL: '{{previewUrl}}',
          HOST: '{{ previewHost }}',
          DB: 'db_{{prNumber}}',
          REF: '{{branch}}@{{sha}}',
          PLAIN: 'unchanged',
        },
        values,
      ),
    ).toEqual({
      URL: values.previewUrl,
      HOST: values.previewHost,
      DB: 'db_4',
      REF: `feat/x@${'f'.repeat(40)}`,
      PLAIN: 'unchanged',
    });
  });

  it('leaves unknown placeholders alone', () => {
    expect(renderPreviewEnvOverrides({ A: '{{nope}}' }, values)).toEqual({ A: '{{nope}}' });
  });

  it('rejects unknown placeholders and reserved keys on save', () => {
    expect(PreviewEnvOverrides.safeParse({ URL: '{{previewUrl}}' }).success).toBe(true);
    expect(PreviewEnvOverrides.safeParse({ URL: '{{previewURL}}' }).success).toBe(false);
    expect(PreviewEnvOverrides.safeParse({ LAUNCHWAY_X: 'a' }).success).toBe(false);
    expect(PreviewEnvOverrides.safeParse({ 'bad key': 'a' }).success).toBe(false);
  });

  it('accepts partial preview settings in app updates', () => {
    expect(UpdateAppInput.safeParse({ previews: { enabled: true } }).success).toBe(true);
    expect(UpdateAppInput.safeParse({ previews: { unknown: 1 } }).success).toBe(false);
    expect(AppPreviewSettings.safeParse(DEFAULT_APP_PREVIEW_SETTINGS).success).toBe(true);
  });

  it('trims the required label and accepts null to drop it', () => {
    const update = (requireLabel: unknown) =>
      UpdateAppInput.safeParse({ previews: { skipBots: false, requireLabel } });
    expect(update(' preview ').data?.previews?.requireLabel).toBe('preview');
    expect(update(null).success).toBe(true);
    expect(update('  ').success).toBe(false);
    expect(update('pre\nview').success).toBe(false);
    expect(update('x'.repeat(101)).success).toBe(false);
  });
});
