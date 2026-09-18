import { describe, expect, it } from 'vitest';
import {
  extractChangelogSection,
  isNewerVersion,
  parseVersion,
  stripVersionPrefix,
} from './releaseCheck';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- work in progress

## [0.3.2] - 2026-09-14

### Added

- download links for detected agents

### Fixed

- hosted Mem0 starts disabled until authenticated

## [0.3.1] - 2026-09-14

Maintenance release for the distribution pipeline.
`;

describe('stripVersionPrefix', () => {
  it('removes a leading v regardless of case', () => {
    expect(stripVersionPrefix('v0.3.7')).toBe('0.3.7');
    expect(stripVersionPrefix('V0.3.7')).toBe('0.3.7');
    expect(stripVersionPrefix(' 0.3.7 ')).toBe('0.3.7');
  });
});

describe('parseVersion', () => {
  it('parses the version core and drops pre-release metadata', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.3.8-beta.1')).toEqual([0, 3, 8]);
    expect(parseVersion('1.0.0+build.5')).toEqual([1, 0, 0]);
  });

  it('treats unparseable segments as zero', () => {
    expect(parseVersion('nonsense')).toEqual([0]);
  });
});

describe('isNewerVersion', () => {
  it('detects a newer patch/minor/major', () => {
    expect(isNewerVersion('0.3.8', '0.3.7')).toBe(true);
    expect(isNewerVersion('0.4.0', '0.3.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('0.3.10', '0.3.9')).toBe(true);
    expect(isNewerVersion('0.3.9', '0.3.10')).toBe(false);
  });

  it('ignores the v prefix and treats equal/older as not newer', () => {
    expect(isNewerVersion('v0.3.7', '0.3.7')).toBe(false);
    expect(isNewerVersion('0.3.7', '0.3.8')).toBe(false);
  });

  it('does not treat a pre-release of the running version as newer', () => {
    expect(isNewerVersion('0.3.7-beta.1', '0.3.7')).toBe(false);
    expect(isNewerVersion('0.3.8-beta.1', '0.3.7')).toBe(true);
  });

  it('never treats a malformed tag as newer', () => {
    expect(isNewerVersion('nonsense', '0.3.7')).toBe(false);
  });
});

describe('extractChangelogSection', () => {
  it('returns the body of the matching version section', () => {
    const body = extractChangelogSection(CHANGELOG, 'v0.3.2');
    expect(body).toContain('### Added');
    expect(body).toContain('download links for detected agents');
    expect(body).toContain('hosted Mem0 starts disabled');
    expect(body).not.toContain('0.3.1');
  });

  it('handles a version heading with no subheadings', () => {
    expect(extractChangelogSection(CHANGELOG, '0.3.1')).toBe(
      'Maintenance release for the distribution pipeline.'
    );
  });

  it('returns null when the version is absent or empty', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull();
    expect(extractChangelogSection(CHANGELOG, '')).toBeNull();
  });
});
