export const RELEASE_REPO = 'flashlan/aurapunk-ide';

/** The card asks for an hourly check; GitHub unauthenticated allows 60 req/h. */
export const RELEASE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface GithubRelease {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  published_at?: string | null;
}

export interface LatestRelease {
  version: string;
  name: string | null;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface ReleaseStatus {
  currentVersion: string;
  latest: LatestRelease;
  hasUpdate: boolean;
}

/** Strip a leading `v`/`V` so `v0.3.7` and `0.3.7` compare equal. */
export function stripVersionPrefix(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * Parse a version's core (major.minor.patch) into numeric segments. The
 * pre-release/build metadata after `-`/`+` is dropped so a pre-release of the
 * running version (`0.3.7-beta.1`) never looks newer than the stable `0.3.7`.
 * Anything unparseable becomes 0 so a malformed tag never looks newer.
 */
export function parseVersion(raw: string): number[] {
  const core = stripVersionPrefix(raw).split(/[-+]/, 1)[0];
  return core
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
}

/** True when `latest` is a strictly higher version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest);
  const active = parseVersion(current);
  const length = Math.max(next.length, active.length);
  for (let index = 0; index < length; index += 1) {
    const left = next[index] ?? 0;
    const right = active[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull the changelog body for a given version out of a Keep-a-Changelog
 * document (`## [0.3.2] - 2026-09-14`). Returns null when the section is
 * missing or empty, so callers can fall back to a placeholder.
 */
export function extractChangelogSection(
  markdown: string,
  version: string
): string | null {
  const target = stripVersionPrefix(version);
  if (!target) return null;
  const heading = new RegExp(
    `^##\\s*\\[?v?${escapeRegExp(target)}\\]?\\b.*$`,
    'm'
  );
  const match = heading.exec(markdown);
  if (!match || match.index === undefined) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^##\s+\[/m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  return body.length > 0 ? body : null;
}

async function fetchCurrentVersion(): Promise<string> {
  const response = await fetch('/api/build-info', {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`build-info returned ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { version?: string };
  } | null;
  const version = body?.data?.version;
  if (!version) throw new Error('build-info response missing version');
  return version;
}

async function fetchGithubLatestRelease(): Promise<GithubRelease> {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!response.ok) {
    throw new Error(`latest release returned ${response.status}`);
  }
  return (await response.json()) as GithubRelease;
}

/**
 * GitHub release bodies are empty in this repo's release workflow, so fall
 * back to the matching CHANGELOG.md section at the release tag.
 */
async function fetchChangelogNotes(tag: string): Promise<string | null> {
  const response = await fetch(
    `https://raw.githubusercontent.com/${RELEASE_REPO}/${tag}/CHANGELOG.md`
  );
  if (!response.ok) return null;
  const markdown = await response.text();
  return extractChangelogSection(markdown, tag);
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const release = await fetchGithubLatestRelease();
  const tag = (release.tag_name ?? '').trim();
  if (!tag) throw new Error('latest release missing tag_name');

  let notes = release.body?.trim() || null;
  if (!notes) {
    notes = await fetchChangelogNotes(tag).catch(() => null);
  }

  return {
    version: stripVersionPrefix(tag),
    name: release.name ?? null,
    notes,
    url: release.html_url ?? null,
    publishedAt: release.published_at ?? null,
  };
}

/** Compare the running build against the latest published GitHub release. */
export async function fetchReleaseStatus(): Promise<ReleaseStatus> {
  const [currentVersion, latest] = await Promise.all([
    fetchCurrentVersion(),
    fetchLatestRelease(),
  ]);
  return {
    currentVersion,
    latest,
    hasUpdate: isNewerVersion(latest.version, currentVersion),
  };
}
