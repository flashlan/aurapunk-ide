import { describe, expect, it } from 'vitest';
import {
  LAYA_PROBE_COLORS,
  buildLayaTooltip,
  isRlcdConfigured,
  layaModeLabel,
  resolveLayaEndpoint,
} from './layaStatus';

describe('resolveLayaEndpoint', () => {
  it('picks the cloud gateway in cloud mode', () => {
    expect(
      resolveLayaEndpoint('cloud', 'http://localhost:8080', 'https://gw.dev')
    ).toBe('https://gw.dev');
  });

  it('picks the Docker URL in docker mode', () => {
    expect(
      resolveLayaEndpoint('docker', 'http://localhost:8080', 'https://gw.dev')
    ).toBe('http://localhost:8080');
  });
});

describe('layaModeLabel', () => {
  it('distinguishes cloud from the local container', () => {
    expect(layaModeLabel('cloud')).toContain('Cloud');
    expect(layaModeLabel('docker')).toContain('Local');
    expect(layaModeLabel('docker')).toContain('Docker');
  });
});

describe('buildLayaTooltip', () => {
  it('reports the mode, latency and endpoint when operational', () => {
    const tooltip = buildLayaTooltip({
      mode: 'docker',
      state: 'online',
      endpoint: 'http://localhost:8080',
      latencyMs: 42,
    });
    expect(tooltip).toContain('Laya — Local (Docker container)');
    expect(tooltip).toContain('Operational (42 ms)');
    expect(tooltip).toContain('Endpoint: http://localhost:8080');
    expect(tooltip).toContain('Settings → Usage');
  });

  it('includes the failure reason when offline', () => {
    const tooltip = buildLayaTooltip({
      mode: 'docker',
      state: 'offline',
      endpoint: 'http://localhost:8080',
      error: 'fetch failed',
    });
    expect(tooltip).toContain('Unavailable — fetch failed');
  });

  it('asks for sign-in when Cloud has no device token', () => {
    const tooltip = buildLayaTooltip({
      mode: 'cloud',
      state: 'unauthorized',
      endpoint: 'https://gw.dev/api/memory/v1',
    });
    expect(tooltip).toContain('Laya — Cloud (AuraPunk Cloud)');
    expect(tooltip).toContain('Sign-in required');
    expect(tooltip).toContain('Sign in to AuraPunk Cloud');
  });

  it('says when no endpoint is configured', () => {
    const tooltip = buildLayaTooltip({
      mode: 'docker',
      state: 'offline',
      endpoint: '',
      error: 'no endpoint configured',
    });
    expect(tooltip).toContain('Endpoint: not configured');
  });
});

describe('LAYA_PROBE_COLORS', () => {
  it('keeps every actionable state distinct from the neutral ones', () => {
    // online / unauthorized / offline must never collide, and none of them may
    // borrow the gray that means "nothing to say" (still checking, or off).
    const actionable = [
      LAYA_PROBE_COLORS.online,
      LAYA_PROBE_COLORS.unauthorized,
      LAYA_PROBE_COLORS.offline,
    ];
    expect(new Set(actionable).size).toBe(actionable.length);
    for (const color of actionable) {
      expect(color).not.toBe(LAYA_PROBE_COLORS.checking);
      expect(color).not.toBe(LAYA_PROBE_COLORS.disabled);
    }
  });

  it('renders disabled as gray, never as a fault color', () => {
    expect(LAYA_PROBE_COLORS.disabled).toBe(LAYA_PROBE_COLORS.checking);
    expect(LAYA_PROBE_COLORS.disabled).not.toBe(LAYA_PROBE_COLORS.offline);
    expect(LAYA_PROBE_COLORS.disabled).not.toBe(LAYA_PROBE_COLORS.unauthorized);
  });
});

describe('isRlcdConfigured', () => {
  it('treats a missing config as not configured', () => {
    expect(isRlcdConfigured(null)).toBe(false);
  });

  it('needs a URL for the laya engine', () => {
    expect(isRlcdConfigured({ engine: 'laya', laya_url: null })).toBe(false);
    expect(
      isRlcdConfigured({ engine: 'laya', laya_url: 'http://localhost:8080' })
    ).toBe(true);
  });

  it('needs a key for the jev engine', () => {
    expect(
      isRlcdConfigured({ engine: 'jev', has_jev_key: false, jev_url: 'https://x' })
    ).toBe(false);
    expect(
      isRlcdConfigured({ engine: 'jev', has_jev_key: true, jev_url: 'https://x' })
    ).toBe(true);
  });

  it('accepts either target when adaptive', () => {
    expect(
      isRlcdConfigured({ engine: 'adaptive', laya_url: null, has_jev_key: false })
    ).toBe(false);
    expect(
      isRlcdConfigured({ engine: 'adaptive', laya_url: 'http://x', has_jev_key: false })
    ).toBe(true);
    expect(
      isRlcdConfigured({ engine: 'adaptive', laya_url: null, has_jev_key: true })
    ).toBe(true);
  });

  it('ignores a Laya token on its own — targets() requires the URL', () => {
    expect(
      isRlcdConfigured({ engine: 'adaptive', laya_url: null, has_laya_token: true })
    ).toBe(false);
  });
});

describe('buildLayaTooltip when disabled', () => {
  it('explains the engine is off instead of reporting a failure', () => {
    const tooltip = buildLayaTooltip({
      mode: 'docker',
      state: 'disabled',
      endpoint: 'http://localhost:8080',
    });
    expect(tooltip).toContain('Disabled — no decision engine configured');
    expect(tooltip).toContain('Settings → Add-ons');
    expect(tooltip).not.toContain('Unavailable');
    expect(tooltip).not.toContain('Sign-in required');
  });
});
