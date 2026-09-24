import { describe, expect, it } from 'vitest';
import {
  LAYA_PROBE_COLORS,
  buildLayaTooltip,
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
  it('uses distinct colors for every probe state', () => {
    const colors = Object.values(LAYA_PROBE_COLORS);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
