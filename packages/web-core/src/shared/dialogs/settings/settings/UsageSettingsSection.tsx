import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeRequest } from '@/shared/lib/remoteApi';
import { handleApiResponse } from '@/shared/lib/api';
import {
  useCompactionThreshold,
  useSetCompactionThreshold,
  useCompactorEngine,
  useSetCompactorEngine,
  useLayaMode,
  useSetLayaMode,
  useLayaDockerUrl,
  useSetLayaDockerUrl,
  useLayaCloudUrl,
  useSetLayaCloudUrl,
  useJevApiKey,
  useSetJevApiKey,
  useJevProviderMode,
  useSetJevProviderMode,
  useJevTypesafeUrl,
  useSetJevTypesafeUrl,
  useJevVercelUrl,
  useSetJevVercelUrl,
  useJevVercelKey,
  useSetJevVercelKey,
  useLayaGuardrailsEnabled,
  useSetLayaGuardrailsEnabled,
  type CompactionThreshold,
  type CompactorEngineType,
} from '@/shared/stores/useUiPreferencesStore';
import {
  ScissorsIcon,
  SparkleIcon,
  CpuIcon,
  ShieldCheckIcon,
  KeyIcon,
} from '@phosphor-icons/react';

export interface DailyAgentActivity {
  day: string;
  agent: string;
  executions: number;
  seconds: number;
}

export interface DailyIssueActivity {
  day: string;
  created: number;
  completed: number;
}

export interface ProjectProgress {
  project_id: string;
  name: string;
  total: number;
  done: number;
  open: number;
}

export interface Mem0TokenProvider {
  provider: string;
  model: string;
  prompt: number;
  completion: number;
}

export interface Mem0TokenDay {
  day: string;
  prompt: number;
  completion: number;
  total: number;
  providers: Mem0TokenProvider[];
}

export interface Mem0TokenUsage {
  days: Mem0TokenDay[];
  providers: Mem0TokenProvider[];
  total: number;
}

export interface Mem0RelevanceDay {
  day: string;
  calls: number;
  weak_calls: number;
  avg_top_score: number | null;
}

export interface Mem0RelevanceSummary {
  days: Mem0RelevanceDay[];
  total_calls: number;
  total_weak_calls: number;
}

export interface TokenTelemetryAgent {
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface TokenTelemetryDay {
  day: string;
  agents: TokenTelemetryAgent[];
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
}

export interface TokenTelemetrySummary {
  days: TokenTelemetryDay[];
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  cache_hit_pct: number | null;
}

export interface TokenUsageBreakdown {
  issue_id: string | null;
  issue_title: string | null;
  agent: string;
  provider: string | null;
  model: string | null;
  executions: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface AgentProgressPoint {
  minute: string;
  hits: number;
  weak_recalls: number;
  failures: number;
}

export interface MemoryGraphNode {
  id: string;
  type: string;
  description: string;
  degree: number;
}

export interface MemoryGraphEdge {
  subject: string;
  predicate: string;
  object: string;
}

export interface MemoryGraphOverview {
  user_id: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated: boolean;
}

export interface ProviderQuotaWindow {
  name: string;
  used_percent: number | null;
  limit_value: number | null;
  used_value: number | null;
  unit: string | null;
  duration_minutes: number | null;
  resets_at: number | null;
  status: string | null;
}

export interface ProviderQuotaSnapshot {
  provider: string;
  plan: string | null;
  windows: ProviderQuotaWindow[];
  credits_balance: string | null;
  credits_unlimited: boolean;
  status: string | null;
  observed_at: number;
}

export interface UsageSummary {
  activity: DailyAgentActivity[];
  issues: DailyIssueActivity[];
  projects: ProjectProgress[];
  issues_lifecycle: IssueLifecycleSummary;
  total_executions: number;
  total_seconds: number;
  mem0_tokens: Mem0TokenUsage;
  mem0_relevance: Mem0RelevanceSummary;
  agent_progress: AgentProgressPoint[];
  token_telemetry: TokenTelemetrySummary;
  token_usage: TokenUsageBreakdown[];
  provider_limits: ProviderQuotaSnapshot[];
}

export async function fetchMemoryGraph(
  userId: string
): Promise<MemoryGraphOverview> {
  const response = await makeRequest('/api/usage/memory-graph', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  return handleApiResponse<MemoryGraphOverview>(response);
}

/** Aggregate issue lifecycle counts across all projects. */
export interface IssueLifecycleSummary {
  total: number;
  todo: number;
  done: number;
  archived: number;
  avg_lifecycle_seconds: number;
}

export interface ReExtractResponse {
  ok: boolean;
  scanned: number;
  updated: number;
  entities: number;
  relations: number;
}

export async function fetchUsageSummary(): Promise<UsageSummary> {
  const response = await makeRequest('/api/usage/summary', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<UsageSummary>(response);
}

export async function triggerReExtract(
  userId: string
): Promise<ReExtractResponse> {
  const response = await makeRequest(
    `/api/usage/re-extract?user_id=${encodeURIComponent(userId)}`,
    { method: 'POST', cache: 'no-store' }
  );
  return handleApiResponse<ReExtractResponse>(response);
}

/** Report accumulated token usage for a given agent. Best-effort, fire-and-forget. */
export async function reportTokenTelemetry(data: {
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): Promise<void> {
  try {
    await makeRequest('/api/usage/token-telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // Best-effort: silently ignore failures.
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

/** GitHub-style activity level 0..4 based on how active a day was. */
function activityLevel(count: number, max: number): number {
  if (count === 0 || max === 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

const ACTIVITY_COLORS = [
  'bg-panel',
  'bg-brand/25',
  'bg-brand/50',
  'bg-brand/75',
  'bg-brand',
];

/** Stable color per extraction provider (llama / openrouter / groq / other). */
function providerColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('groq')) return 'bg-red-500/80';
  if (p.includes('openrouter')) return 'bg-sky-500/80';
  if (p.includes('llama') || p.includes('ollama')) return 'bg-emerald-500/80';
  if (p.includes('openai')) return 'bg-amber-500/80';
  return 'bg-purple-500/80';
}

/** Stable color for coding agents in token telemetry. */
function agentColor(agent: string): string {
  const a = agent.toLowerCase();
  if (a.includes('claude')) return 'bg-amber-500/80';
  if (a.includes('antigravity') || a.includes('gemini')) return 'bg-sky-500/80';
  if (a.includes('codex') || a.includes('openai')) return 'bg-emerald-500/80';
  if (a.includes('opencode')) return 'bg-violet-500/80';
  if (a.includes('cursor')) return 'bg-rose-500/80';
  if (a.includes('copilot')) return 'bg-teal-500/80';
  return 'bg-purple-500/80';
}

/** Format large token counts: 1.2M, 45.3K, or raw number. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatQuotaName(name: string): string {
  return name
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatQuotaReset(timestamp: number | null): string {
  if (timestamp == null) return '—';
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatQuotaLimit(window: ProviderQuotaWindow): string | null {
  if (window.limit_value == null) return null;
  if (window.unit === 'usd') return `$${window.limit_value}`;
  return `${window.limit_value} ${window.unit ?? ''}`.trim();
}

function seededUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** A deterministic, bounded force layout without exposing the backing store. */
function MemoryGraphCanvas({ graph }: { graph: MemoryGraphOverview }) {
  const layout = useMemo(() => {
    const width = 880;
    const height = 340;
    const positions = new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          x: 80 + seededUnit(`${node.id}:x`) * (width - 160),
          y: 46 + seededUnit(`${node.id}:y`) * (height - 92),
          z: seededUnit(`${node.id}:z`),
        },
      ])
    );
    for (let iteration = 0; iteration < 90; iteration += 1) {
      const force = new Map(
        graph.nodes.map((node) => [node.id, { x: 0, y: 0 }])
      );
      for (let left = 0; left < graph.nodes.length; left += 1) {
        for (let right = left + 1; right < graph.nodes.length; right += 1) {
          const a = positions.get(graph.nodes[left].id)!;
          const b = positions.get(graph.nodes[right].id)!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.max(16, Math.hypot(dx, dy));
          const strength = 1100 / (distance * distance);
          force.get(graph.nodes[left].id)!.x += (dx / distance) * strength;
          force.get(graph.nodes[left].id)!.y += (dy / distance) * strength;
          force.get(graph.nodes[right].id)!.x -= (dx / distance) * strength;
          force.get(graph.nodes[right].id)!.y -= (dy / distance) * strength;
        }
      }
      for (const edge of graph.edges) {
        const a = positions.get(edge.subject);
        const b = positions.get(edge.object);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const strength = (distance - 105) * 0.012;
        force.get(edge.subject)!.x += (dx / distance) * strength;
        force.get(edge.subject)!.y += (dy / distance) * strength;
        force.get(edge.object)!.x -= (dx / distance) * strength;
        force.get(edge.object)!.y -= (dy / distance) * strength;
      }
      for (const node of graph.nodes) {
        const point = positions.get(node.id)!;
        const movement = force.get(node.id)!;
        point.x = Math.min(width - 28, Math.max(28, point.x + movement.x));
        point.y = Math.min(height - 24, Math.max(24, point.y + movement.y));
      }
    }
    return { width, height, positions };
  }, [graph]);

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="h-[340px] w-full rounded-sm border border-border bg-secondary/25"
      role="img"
      aria-label="Semantic memory relationship graph"
    >
      <defs>
        <radialGradient id="memory-node" cx="35%" cy="30%">
          <stop stopColor="var(--color-brand, #60a5fa)" stopOpacity="1" />
          <stop
            offset="1"
            stopColor="var(--color-brand, #60a5fa)"
            stopOpacity=".28"
          />
        </radialGradient>
      </defs>
      {graph.edges.map((edge) => {
        const source = layout.positions.get(edge.subject);
        const target = layout.positions.get(edge.object);
        if (!source || !target) return null;
        return (
          <line
            key={`${edge.subject}:${edge.predicate}:${edge.object}`}
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            stroke="currentColor"
            strokeOpacity="0.22"
            strokeWidth="1"
            className="text-brand"
          />
        );
      })}
      {graph.nodes.map((node) => {
        const point = layout.positions.get(node.id)!;
        const radius = 5 + Math.min(8, node.degree * 1.25) + point.z * 2;
        return (
          <g key={node.id} className="group cursor-default">
            <title>{`${node.id}${node.description ? ` — ${node.description}` : ''}`}</title>
            <circle
              cx={point.x}
              cy={point.y}
              r={radius + 7}
              fill="var(--color-brand, #60a5fa)"
              opacity="0.07"
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={radius}
              fill="url(#memory-node)"
              stroke="var(--color-brand, #60a5fa)"
              strokeOpacity="0.8"
            />
            <text
              x={point.x + radius + 6}
              y={point.y + 4}
              className="fill-high text-[10px] opacity-75 group-hover:opacity-100"
            >
              {node.id.length > 28 ? `${node.id.slice(0, 27)}…` : node.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ProgressScatterChart({ points }: { points: AgentProgressPoint[] }) {
  if (points.length === 0) return null;
  const width = 880;
  const height = 150;
  const max = Math.max(
    1,
    ...points.flatMap((point) => [
      point.hits,
      point.weak_recalls,
      point.failures,
    ])
  );
  const x = (index: number) =>
    24 + (index / Math.max(1, points.length - 1)) * (width - 48);
  const y = (value: number) => height - 22 - (value / max) * (height - 42);
  const series = [
    { key: 'hits', color: '#34d399', label: 'Hits' },
    { key: 'weak_recalls', color: '#fbbf24', label: 'Weak recalls' },
    { key: 'failures', color: '#f87171', label: 'Failures' },
  ] as const;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[150px] w-full"
      role="img"
      aria-label="Agent progress per minute"
    >
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1="24"
          x2={width - 24}
          y1={height - 22 - ratio * (height - 42)}
          y2={height - 22 - ratio * (height - 42)}
          className="stroke-border"
          strokeDasharray="3 4"
        />
      ))}
      {series.map((line) => (
        <g key={line.key}>
          <polyline
            fill="none"
            stroke={line.color}
            strokeWidth="1.5"
            strokeOpacity=".65"
            points={points
              .map((point, index) => `${x(index)},${y(point[line.key])}`)
              .join(' ')}
          />
          {points.map(
            (point, index) =>
              point[line.key] > 0 && (
                <circle
                  key={`${line.key}-${point.minute}`}
                  cx={x(index)}
                  cy={y(point[line.key])}
                  r="3"
                  fill={line.color}
                >
                  <title>{`${line.label}: ${point[line.key]} · ${point.minute}`}</title>
                </circle>
              )
          )}
        </g>
      ))}
    </svg>
  );
}

export function UsageSettingsSection() {
  const { t } = useTranslation('settings');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reExtractUser, setReExtractUser] = useState('');
  const [reExtractBusy, setReExtractBusy] = useState(false);
  const [reExtractResult, setReExtractResult] =
    useState<ReExtractResponse | null>(null);
  const [memoryGraph, setMemoryGraph] = useState<MemoryGraphOverview | null>(
    null
  );
  const [memoryGraphLoading, setMemoryGraphLoading] = useState(false);
  const [memoryGraphError, setMemoryGraphError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setSummary(await fetchUsageSummary());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage data');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMemoryGraph = useCallback(async (userId: string) => {
    setMemoryGraphLoading(true);
    setMemoryGraphError(null);
    try {
      setMemoryGraph(await fetchMemoryGraph(userId.trim() || 'default'));
    } catch (e) {
      setMemoryGraph(null);
      setMemoryGraphError(
        e instanceof Error ? e.message : 'Failed to load memory graph'
      );
    } finally {
      setMemoryGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMemoryGraph('default');
  }, [loadMemoryGraph]);

  const handleReExtract = async () => {
    const userId = reExtractUser.trim() || 'default';
    setReExtractBusy(true);
    setReExtractResult(null);
    try {
      setError(null);
      const res = await triggerReExtract(userId);
      setReExtractResult(res);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-extraction failed');
    } finally {
      setReExtractBusy(false);
    }
  };

  // Build last-30-days grid. `activity` maps "YYYY-MM-DD" -> executions.
  const activityByDay = new Map<string, number>();
  const byDayAgent = new Map<string, Map<string, number>>();
  let maxDaily = 0;
  for (const row of summary?.activity ?? []) {
    const execs = activityByDay.get(row.day) ?? 0;
    activityByDay.set(row.day, execs + row.executions);
    maxDaily = Math.max(maxDaily, execs + row.executions);
    const byAgent = byDayAgent.get(row.day) ?? new Map<string, number>();
    byAgent.set(row.agent, (byAgent.get(row.agent) ?? 0) + row.executions);
    byDayAgent.set(row.day, byAgent);
  }

  const days: { date: Date; label: string; level: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toISOString().slice(0, 10);
    days.push({
      date: d,
      label,
      level: activityLevel(activityByDay.get(label) ?? 0, maxDaily),
    });
  }

  // Agent totals across the window.
  const agentTotals = new Map<string, number>();
  for (const row of summary?.activity ?? []) {
    agentTotals.set(
      row.agent,
      (agentTotals.get(row.agent) ?? 0) + row.executions
    );
  }
  const agents = [...agentTotals.entries()].sort((a, b) => b[1] - a[1]);

  const issueCreated = new Map<string, number>();
  const issueCompleted = new Map<string, number>();
  let maxIssues = 0;
  for (const row of summary?.issues ?? []) {
    issueCreated.set(row.day, row.created);
    issueCompleted.set(row.day, row.completed);
    maxIssues = Math.max(maxIssues, row.created, row.completed);
  }

  const compactionThreshold = useCompactionThreshold();
  const setCompactionThreshold = useSetCompactionThreshold();

  const compactorEngine = useCompactorEngine();
  const setCompactorEngine = useSetCompactorEngine();
  const layaMode = useLayaMode();
  const setLayaMode = useSetLayaMode();
  const layaDockerUrl = useLayaDockerUrl();
  const setLayaDockerUrl = useSetLayaDockerUrl();
  const layaCloudUrl = useLayaCloudUrl();
  const setLayaCloudUrl = useSetLayaCloudUrl();
  const jevApiKey = useJevApiKey();
  const setJevApiKey = useSetJevApiKey();
  const jevProviderMode = useJevProviderMode();
  const setJevProviderMode = useSetJevProviderMode();
  const jevTypesafeUrl = useJevTypesafeUrl();
  const setJevTypesafeUrl = useSetJevTypesafeUrl();
  const jevVercelUrl = useJevVercelUrl();
  const setJevVercelUrl = useSetJevVercelUrl();
  const jevVercelKey = useJevVercelKey();
  const setJevVercelKey = useSetJevVercelKey();
  const layaGuardrailsEnabled = useLayaGuardrailsEnabled();
  const setLayaGuardrailsEnabled = useSetLayaGuardrailsEnabled();

  const ENGINE_OPTIONS: Array<{
    id: CompactorEngineType;
    label: string;
    sublabel: string;
    badge?: string;
  }> = [
    {
      id: 'auto',
      label: 'Auto (Jev + Laya)',
      sublabel: 'Cloud Jev with Laya (Docker/Cloud) fallback',
      badge: 'Recommended',
    },
    {
      id: 'laya',
      label: 'Laya System-1',
      sublabel: 'Docker container or AuraPunk Cloud (no Embedded)',
    },
    {
      id: 'jev',
      label: 'TypeSafe Jev',
      sublabel: 'Cloud API (Requires API Key)',
    },
    {
      id: 'disabled',
      label: 'Traditional (Off)',
      sublabel: 'Standard LLM text summarization fallback',
    },
  ];

  const THRESHOLD_OPTIONS: Array<{
    id: CompactionThreshold;
    label: string;
    sublabel: string;
    isIdeal?: boolean;
    isEco?: boolean;
    isFocus?: boolean;
  }> = [
    { id: '50', label: '50%', sublabel: 'Focus', isFocus: true },
    { id: '65', label: '65%', sublabel: 'Eco', isEco: true },
    { id: '75', label: '75%', sublabel: 'Early' },
    { id: '85', label: '85%', sublabel: 'Ideal (Recommended)', isIdeal: true },
    { id: '95', label: '95%', sublabel: 'Late' },
    { id: 'full', label: 'Full', sublabel: 'Reactive on error' },
  ];

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      {error && (
        <div className="rounded-sm bg-error/10 border border-error/30 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="text-2xl font-semibold text-high">
            {summary?.total_executions ?? '—'}
          </div>
          <div className="text-xs text-low">
            {t('settings.usage.executions', 'Executions (30d)')}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="text-2xl font-semibold text-high">
            {summary ? formatDuration(summary.total_seconds) : '—'}
          </div>
          <div className="text-xs text-low">
            {t('settings.usage.time', 'Agent time (30d)')}
          </div>
        </div>
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="text-2xl font-semibold text-high">
            {summary
              ? `${summary.projects.reduce((n, p) => n + p.open, 0)}`
              : '—'}
          </div>
          <div className="text-xs text-low">
            {t('settings.usage.openIssues', 'Open issues')}
          </div>
        </div>
      </div>

      {/* Issues lifecycle (aggregate) */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.issuesLifecycle', 'Issues lifecycle')}
        </h3>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          <div className="rounded-sm border border-border bg-panel p-3">
            <div className="text-2xl font-semibold text-high">
              {summary?.issues_lifecycle.total ?? '—'}
            </div>
            <div className="text-xs text-low">
              {t('settings.usage.totalCards', 'Total cards')}
            </div>
          </div>
          <div className="rounded-sm border border-border bg-panel p-3">
            <div className="text-2xl font-semibold text-high">
              {summary?.issues_lifecycle.todo ?? '—'}
            </div>
            <div className="text-xs text-low">
              {t('settings.usage.todoCards', 'Todo')}
            </div>
          </div>
          <div className="rounded-sm border border-border bg-panel p-3">
            <div className="text-2xl font-semibold text-high">
              {summary?.issues_lifecycle.done ?? '—'}
            </div>
            <div className="text-xs text-low">
              {t('settings.usage.doneCards', 'Concluded')}
            </div>
          </div>
          <div className="rounded-sm border border-border bg-panel p-3">
            <div className="text-2xl font-semibold text-high">
              {summary?.issues_lifecycle.archived ?? '—'}
            </div>
            <div className="text-xs text-low">
              {t('settings.usage.archivedCards', 'Archived')}
            </div>
          </div>
          <div className="rounded-sm border border-border bg-panel p-3">
            <div className="text-2xl font-semibold text-high">
              {summary?.issues_lifecycle.avg_lifecycle_seconds != null
                ? formatDuration(summary.issues_lifecycle.avg_lifecycle_seconds)
                : '—'}
            </div>
            <div className="text-xs text-low">
              {t('settings.usage.avgLifecycle', 'Avg card life')}
            </div>
          </div>
        </div>
      </section>

      {/* GitHub-style activity squares */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.activity', 'Activity (last 30 days)')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-1">
            {days.map((d) => (
              <div
                key={d.label}
                title={`${d.label}: ${activityByDay.get(d.label) ?? 0} executions`}
                className={`aspect-square w-full rounded-[3px] ${ACTIVITY_COLORS[d.level]}`}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1 text-[10px] text-low">
            <span>{t('settings.usage.less', 'Less')}</span>
            {ACTIVITY_COLORS.map((c) => (
              <span key={c} className={`h-2.5 w-2.5 rounded-[3px] ${c}`} />
            ))}
            <span>{t('settings.usage.more', 'More')}</span>
          </div>
        </div>
      </section>

      {/* Bars per day by agent */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.byAgent', 'Executions per day by agent')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          {agents.length === 0 ? (
            <div className="text-sm text-low">
              {t('settings.usage.empty', 'No activity in the last 30 days.')}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {agents.map(([agent, total]) => (
                <div key={agent} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-xs text-normal">
                    {agent}
                  </span>
                  <div className="flex h-14 flex-1 items-end gap-px">
                    {days.map((d) => {
                      const n = byDayAgent.get(d.label)?.get(agent) ?? 0;
                      const h =
                        maxDaily > 0
                          ? Math.max(2, Math.round((n / maxDaily) * 56))
                          : 2;
                      return (
                        <div
                          key={d.label}
                          title={`${d.label}: ${n}`}
                          className="w-full rounded-[2px] bg-brand/40"
                          style={{ height: n > 0 ? h : 2 }}
                        />
                      );
                    })}
                  </div>
                  <span className="w-12 shrink-0 text-right text-xs text-low">
                    {total}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Issue progress per project */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.projects', 'Project & issue progress')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          {(summary?.projects ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t('settings.usage.noProjects', 'No projects yet.')}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {(summary?.projects ?? []).map((p) => {
                const pct =
                  p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                return (
                  <div key={p.project_id}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="truncate text-normal">{p.name}</span>
                      <span className="text-low">
                        {p.done}/{p.total} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-success"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 flex gap-3 text-[10px] text-low">
                      <span>
                        {t('settings.usage.open', 'Open')}: {p.open}
                      </span>
                      <span>
                        {t('settings.usage.done', 'Done')}: {p.done}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ⚡ LLM Token & KV-Cache Telemetry — in-memory, resets on restart */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t(
            'settings.usage.tokenTelemetry',
            '⚡ LLM token & KV-cache telemetry'
          )}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          {/* KPI cards row */}
          <div className="mb-3 grid grid-cols-4 gap-3">
            <div className="rounded-sm bg-secondary p-2">
              <div className="text-lg font-semibold text-high">
                {formatTokens(
                  (summary?.token_telemetry.total_input ?? 0) +
                    (summary?.token_telemetry.total_output ?? 0)
                )}
              </div>
              <div className="text-[10px] text-low">
                {t('settings.usage.totalProcessed', 'Total tokens')}
              </div>
            </div>
            <div className="rounded-sm bg-secondary p-2">
              <div className="text-lg font-semibold text-emerald-500">
                {formatTokens(summary?.token_telemetry.total_cache_read ?? 0)}
              </div>
              <div className="text-[10px] text-low">
                {t('settings.usage.cacheRead', 'Cache read')}
              </div>
            </div>
            <div className="rounded-sm bg-secondary p-2">
              <div className="text-lg font-semibold text-high">
                {summary?.token_telemetry.cache_hit_pct != null
                  ? `${Math.round(summary.token_telemetry.cache_hit_pct * 100)}%`
                  : '—'}
              </div>
              <div className="text-[10px] text-low">
                {t('settings.usage.cacheHit', 'Cache hit %')}
              </div>
            </div>
            <div className="rounded-sm bg-secondary p-2">
              <div className="text-lg font-semibold text-amber-500">
                {formatTokens(
                  summary?.token_telemetry.total_cache_creation ?? 0
                )}
              </div>
              <div className="text-[10px] text-low">
                {t('settings.usage.cacheCreation', 'Cache creation')}
              </div>
            </div>
          </div>

          {/* Per-day segmented bars by agent */}
          {(summary?.token_telemetry.days ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t(
                'settings.usage.noTokenTelemetry',
                'No token telemetry recorded yet this server run (in-memory only — resets on restart).'
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {(summary?.token_telemetry.days ?? []).map((d) => {
                  const dayTotal =
                    d.total_input + d.total_cache_read + d.total_cache_creation;
                  const dayHit =
                    dayTotal > 0
                      ? Math.round((d.total_cache_read / dayTotal) * 100)
                      : 0;
                  return (
                    <div key={d.day} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-xs text-low">
                        {d.day}
                      </span>
                      <div className="flex h-5 flex-1 overflow-hidden rounded-sm bg-secondary">
                        {d.agents.map((a) => {
                          const agentTotal =
                            a.input_tokens +
                            a.cache_read_tokens +
                            a.cache_creation_tokens;
                          const share =
                            dayTotal > 0
                              ? Math.max(
                                  1,
                                  Math.round((agentTotal / dayTotal) * 100)
                                )
                              : 0;
                          return (
                            <div
                              key={a.agent}
                              title={`${a.agent}: ${formatTokens(a.input_tokens)} in · ${formatTokens(a.output_tokens)} out · ${formatTokens(a.cache_read_tokens)} cache read · ${formatTokens(a.cache_creation_tokens)} cache create`}
                              className={agentColor(a.agent)}
                              style={{ width: `${share}%` }}
                            />
                          );
                        })}
                      </div>
                      <span
                        className="w-16 shrink-0 text-right text-xs text-low"
                        title={`${dayHit}% cache hit`}
                      >
                        {dayHit}% hit
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Agent legend */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
                {(() => {
                  const agentMap = new Map<
                    string,
                    {
                      input: number;
                      output: number;
                      read: number;
                      create: number;
                    }
                  >();
                  for (const d of summary?.token_telemetry.days ?? []) {
                    for (const a of d.agents) {
                      const prev = agentMap.get(a.agent) ?? {
                        input: 0,
                        output: 0,
                        read: 0,
                        create: 0,
                      };
                      agentMap.set(a.agent, {
                        input: prev.input + a.input_tokens,
                        output: prev.output + a.output_tokens,
                        read: prev.read + a.cache_read_tokens,
                        create: prev.create + a.cache_creation_tokens,
                      });
                    }
                  }
                  return [...agentMap.entries()].map(([agent, totals]) => {
                    const denom = totals.input + totals.read + totals.create;
                    const hitPct =
                      denom > 0 ? Math.round((totals.read / denom) * 100) : 0;
                    return (
                      <span
                        key={agent}
                        className="flex items-center gap-1.5 text-xs text-low"
                      >
                        <span
                          className={`h-2.5 w-2.5 rounded-sm ${agentColor(agent)}`}
                        />
                        {agent} · {formatTokens(totals.input + totals.output)}{' '}
                        tok · {hitPct}% hit
                      </span>
                    );
                  });
                })()}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Provider account quota — only machine-readable provider data. */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.providerLimits', 'Provider limits')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <p className="mb-3 text-xs text-low">
            {t(
              'settings.usage.providerLimitsNote',
              'Live account windows are shown when the provider exposes them. Local token counts do not represent provider quota consumption.'
            )}
          </p>
          {(summary?.provider_limits ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t(
                'settings.usage.noProviderLimits',
                'No provider quota snapshot is available yet. Run an agent to request the provider status.'
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {(summary?.provider_limits ?? []).map((provider) => (
                <div key={provider.provider}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium text-normal">
                        {provider.provider}
                      </span>
                      {provider.plan && (
                        <span className="ml-2 text-xs text-low">
                          {provider.plan}
                        </span>
                      )}
                    </div>
                    {provider.credits_unlimited && (
                      <span className="text-xs text-low">
                        Unlimited credits
                      </span>
                    )}
                    {!provider.credits_unlimited &&
                      provider.credits_balance && (
                        <span className="text-xs text-low">
                          Credits: {provider.credits_balance}
                        </span>
                      )}
                  </div>
                  {provider.windows.length === 0 ? (
                    <div className="text-xs text-low">
                      Usage windows unavailable from this provider.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {provider.windows.map((window) => {
                        const used = window.used_percent;
                        const remaining =
                          used != null
                            ? Math.max(0, Math.min(100, 100 - used))
                            : null;
                        const limit = formatQuotaLimit(window);
                        return (
                          <div key={window.name}>
                            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                              <span className="text-normal">
                                {formatQuotaName(window.name)}
                              </span>
                              <span className="text-right text-low">
                                {used != null
                                  ? `${Math.round(used)}% used · ${Math.round(remaining ?? 0)}% remaining`
                                  : (limit ?? 'Usage unavailable')}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                              {used != null && (
                                <div
                                  className="h-full rounded-full bg-brand"
                                  style={{
                                    width: `${Math.min(100, Math.max(0, used))}%`,
                                  }}
                                />
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-low">
                              {limit && <span>{limit} limit</span>}
                              {window.duration_minutes && (
                                <span>
                                  {window.duration_minutes} min window
                                </span>
                              )}
                              <span>
                                Resets: {formatQuotaReset(window.resets_at)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 border-t border-border pt-2 text-[10px] text-low">
            Codex and Claude can report live windows. AGY and OpenCode do not
            currently expose a safe live machine-readable quota in the local
            executor, so their remaining usage is not guessed here.
          </p>
        </div>
      </section>

      {/* Durable token ledger — grouped by issue, CLI and model. */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.tokenUsageByIssue', 'Token usage by issue')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <p className="mb-3 text-xs text-low">
            {t(
              'settings.usage.tokenUsageNote',
              'Observed normalized usage over the last 30 days. This is not provider billing or remaining plan quota.'
            )}
          </p>
          {(summary?.token_usage ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t(
                'settings.usage.noTokenUsage',
                'No durable token usage has been recorded yet.'
              )}
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_auto] gap-x-3 border-b border-border pb-2 text-[10px] uppercase text-low">
                <span>{t('settings.usage.issue', 'Issue')}</span>
                <span>{t('settings.usage.agent', 'Agent')}</span>
                <span>{t('settings.usage.model', 'Model')}</span>
                <span className="text-right">
                  {t('settings.usage.tokens', 'Tokens')}
                </span>
              </div>
              <div className="divide-y divide-border">
                {(summary?.token_usage ?? []).map((row, index) => (
                  <div
                    key={`${row.issue_id ?? 'unlinked'}-${row.agent}-${row.model ?? 'default'}-${index}`}
                    className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_auto] gap-x-3 py-2 text-xs"
                  >
                    <span
                      className="truncate text-normal"
                      title={row.issue_id ?? undefined}
                    >
                      {row.issue_title ??
                        t(
                          'settings.usage.unlinkedExecution',
                          'Unlinked execution'
                        )}
                    </span>
                    <span className="truncate text-normal">{row.agent}</span>
                    <span className="truncate text-low">
                      {row.model ??
                        t('settings.usage.defaultModel', 'Default model')}
                    </span>
                    <span className="text-right text-normal">
                      {formatTokens(row.total_tokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* mem0 extraction tokens — segmented bars per provider */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.mem0Tokens', 'mem0 extraction tokens')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xl font-semibold text-high">
              {(summary?.mem0_tokens.total ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-low">
              {t('settings.usage.totalTokens', 'total tokens')}
            </span>
          </div>
          {(summary?.mem0_tokens.days ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t(
                'settings.usage.noTokenData',
                'No extraction tokens recorded yet (mem0 may be offline or the extraction LLM unused).'
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {(summary?.mem0_tokens.days ?? []).map((d) => {
                  return (
                    <div key={d.day} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-xs text-low">
                        {d.day}
                      </span>
                      <div className="flex h-5 flex-1 overflow-hidden rounded-sm bg-secondary">
                        {d.providers.map((p) => {
                          const share =
                            d.total > 0
                              ? Math.max(
                                  1,
                                  Math.round(
                                    ((p.prompt + p.completion) / d.total) * 100
                                  )
                                )
                              : 0;
                          return (
                            <div
                              key={`${p.provider}|${p.model}`}
                              title={`${p.provider} · ${p.model}: ${(p.prompt + p.completion).toLocaleString()} tok`}
                              className={providerColor(p.provider)}
                              style={{ width: `${share}%` }}
                            />
                          );
                        })}
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs text-low">
                        {d.total.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
                {(summary?.mem0_tokens.providers ?? []).map((p) => (
                  <span
                    key={`${p.provider}|${p.model}`}
                    className="flex items-center gap-1.5 text-xs text-low"
                  >
                    <span
                      className={`h-2.5 w-2.5 rounded-sm ${providerColor(p.provider)}`}
                    />
                    {p.provider} · {p.model} ·{' '}
                    {(p.prompt + p.completion).toLocaleString()}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* mem0 recall relevance — memory_search top-score per day, since last
          server restart (in-memory ledger; see ADR-030). */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.mem0Relevance', 'mem0 recall relevance')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xl font-semibold text-high">
              {(summary?.mem0_relevance.total_calls ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-low">
              {t('settings.usage.recallCalls', 'memory_search calls')}
              {(summary?.mem0_relevance.total_weak_calls ?? 0) > 0 && (
                <>
                  {' · '}
                  <span className="text-warning">
                    {(
                      summary?.mem0_relevance.total_weak_calls ?? 0
                    ).toLocaleString()}{' '}
                    {t('settings.usage.weak', 'weak')}
                  </span>
                </>
              )}
            </span>
          </div>
          {(summary?.mem0_relevance.days ?? []).length === 0 ? (
            <div className="text-sm text-low">
              {t(
                'settings.usage.noRelevanceData',
                'No recall calls recorded yet this server run (in-memory only — resets on restart).'
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {(summary?.mem0_relevance.days ?? []).map((d) => {
                const score = d.avg_top_score;
                const widthPct =
                  score != null ? Math.max(4, Math.round(score * 100)) : 0;
                const barColor =
                  score == null
                    ? 'bg-secondary'
                    : score < 0.3
                      ? 'bg-red-500/80'
                      : score < 0.6
                        ? 'bg-amber-500/80'
                        : 'bg-emerald-500/80';
                return (
                  <div key={d.day} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs text-low">
                      {d.day}
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded-sm bg-secondary">
                      <div
                        title={
                          score != null
                            ? `avg top score ${score.toFixed(3)} · ${d.calls} call(s), ${d.weak_calls} weak`
                            : `no scored hits · ${d.calls} call(s), ${d.weak_calls} weak`
                        }
                        className={`h-full ${barColor}`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-xs text-low">
                      {score != null ? score.toFixed(2) : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-high">
              {t('settings.usage.memoryGraph', 'Semantic memory graph')}
            </h3>
            <p className="mt-0.5 text-xs text-low">
              {t(
                'settings.usage.memoryGraphHint',
                'Extracted concepts and relations from Mem0; vector records stay private in Qdrant.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadMemoryGraph(reExtractUser)}
            disabled={memoryGraphLoading}
            className="shrink-0 rounded-sm bg-panel px-3 py-1.5 text-sm text-normal ring-1 ring-border hover:text-high disabled:opacity-50"
          >
            {memoryGraphLoading
              ? t('settings.usage.loadingGraph', 'Loading…')
              : t('settings.usage.refreshGraph', 'Refresh graph')}
          </button>
        </div>
        <div className="rounded-sm border border-border bg-panel p-3">
          {memoryGraphError ? (
            <p className="text-sm text-low">
              {t(
                'settings.usage.graphUnavailable',
                'Graph unavailable. Enable the Mem0 graph service, then try again.'
              )}
            </p>
          ) : memoryGraph && memoryGraph.nodes.length > 0 ? (
            <>
              <MemoryGraphCanvas graph={memoryGraph} />
              <p className="mt-2 text-xs text-low">
                {memoryGraph.nodes.length}{' '}
                {t('settings.usage.graphNodes', 'concepts')} ·{' '}
                {memoryGraph.edges.length}{' '}
                {t('settings.usage.graphEdges', 'relations')}
                {memoryGraph.truncated &&
                  ` · ${t('settings.usage.graphTruncated', 'showing the most connected concepts')}`}
              </p>
            </>
          ) : (
            <p className="text-sm text-low">
              {t(
                'settings.usage.noGraphData',
                'No extracted relations yet. Save memories or run re-extraction for this repository.'
              )}
            </p>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.agentProgress', 'Agent progress — last 24 hours')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          {(summary?.agent_progress ?? []).length === 0 ? (
            <p className="text-sm text-low">
              {t(
                'settings.usage.noAgentProgress',
                'No recall or failed-agent events in the last 24 hours.'
              )}
            </p>
          ) : (
            <>
              <ProgressScatterChart points={summary?.agent_progress ?? []} />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-low">
                <span>
                  <i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />
                  {t('settings.usage.progressHits', 'Hits')}
                </span>
                <span>
                  <i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" />
                  {t('settings.usage.progressWeak', 'Weak recalls')}
                </span>
                <span>
                  <i className="mr-1 inline-block h-2 w-2 rounded-full bg-red-400" />
                  {t('settings.usage.progressFailures', 'Failures')}
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Re-extract graph entities (for memories saved before an LLM was configured) */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.reExtract', 'Re-extract graph entities')}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3">
          <p className="mb-2 text-xs text-low">
            {t(
              'settings.usage.reExtractHint',
              'Run graph extraction for memories stored before an extraction LLM was configured. Enter the repository slug (memories user_id), then trigger.'
            )}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={reExtractUser}
              onChange={(e) => setReExtractUser(e.target.value)}
              placeholder="repo-slug (e.g. vibe-kanban-alternative)"
              className="min-w-0 flex-1 rounded-sm border border-border bg-secondary px-2 py-1.5 text-sm text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              type="button"
              onClick={() => void handleReExtract()}
              disabled={reExtractBusy}
              className="shrink-0 rounded-sm bg-panel px-3 py-1.5 text-sm text-normal ring-1 ring-border hover:text-high disabled:opacity-50"
            >
              {reExtractBusy
                ? t('settings.usage.reExtracting', 'Extracting…')
                : t('settings.usage.reExtractBtn', 'Re-extract')}
            </button>
          </div>
          {reExtractResult && (
            <div className="mt-2 text-xs text-low">
              {t('settings.usage.reExtractResult', 'Scanned', {
                count: reExtractResult.scanned,
              })}{' '}
              · {reExtractResult.entities}{' '}
              {t('settings.usage.reExtractEntities', 'entities')} ·{' '}
              {reExtractResult.relations}{' '}
              {t('settings.usage.reExtractRelations', 'relations')} extracted
            </div>
          )}
        </div>
      </section>

      {/* Context Compaction & Token Limit Management */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-high">
          {t(
            'settings.usage.contextCompaction',
            'Context Compaction & Token Limits'
          )}
        </h3>
        <div className="rounded-sm border border-border bg-panel p-3.5 space-y-3">
          {/* Compactor Engine & Classifier Selector */}
          <div className="rounded-sm border border-border/70 bg-secondary/30 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-high flex items-center gap-1.5">
                <CpuIcon className="size-3.5 text-brand" weight="bold" />
                <span>
                  {t(
                    'settings.usage.compactorEngineTitle',
                    'Compactor Engine & Decision Classifier'
                  )}
                </span>
              </span>
              <span className="text-[11px] text-low">
                {compactorEngine === 'auto' &&
                  '⚡ Cloud Jev + Laya (Docker/Cloud) fallback'}
                {compactorEngine === 'laya' &&
                  (layaMode === 'cloud'
                    ? '☁️ AuraPunk Cloud Laya'
                    : '🐳 Laya Docker container')}
                {compactorEngine === 'jev' && '🌐 TypeSafe Jev Cloud API'}
                {compactorEngine === 'disabled' &&
                  '⏳ Traditional LLM summary fallback'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              {ENGINE_OPTIONS.map((opt) => {
                const isSelected = compactorEngine === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setCompactorEngine(opt.id)}
                    className={`relative flex flex-col items-start justify-center rounded-sm p-2.5 text-left transition-all border cursor-pointer ${
                      isSelected
                        ? opt.id === 'auto'
                          ? 'border-brand bg-brand/15 text-brand ring-1 ring-brand/50 shadow-xs'
                          : 'border-emerald-500 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/50 shadow-xs'
                        : 'border-border bg-panel hover:bg-secondary text-normal'
                    }`}
                  >
                    {opt.badge && (
                      <span className="absolute -top-2 right-2 rounded-full bg-brand px-1.5 py-0.2 text-[9px] font-bold text-white uppercase tracking-wider shadow-xs">
                        {opt.badge}
                      </span>
                    )}
                    <span className="text-xs font-bold">{opt.label}</span>
                    <span className="text-[10px] text-low mt-0.5">
                      {opt.sublabel}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Sub-configuration for Laya (Docker / Cloud) */}
            {(compactorEngine === 'auto' || compactorEngine === 'laya') && (
              <div className="rounded-sm border border-border/50 bg-panel/60 p-2.5 space-y-2 text-xs">
                <div className="flex items-center justify-between font-medium text-normal">
                  <span className="flex items-center gap-1.5">
                    <CpuIcon className="size-3 text-accent" />
                    <span>Laya Execution Mode:</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="layaMode"
                        checked={layaMode === 'docker'}
                        onChange={() => setLayaMode('docker')}
                        className="accent-brand"
                      />
                      <span>Docker Container (Local)</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="layaMode"
                        checked={layaMode === 'cloud'}
                        onChange={() => setLayaMode('cloud')}
                        className="accent-brand"
                      />
                      <span>Cloud</span>
                    </label>
                  </div>
                </div>

                {layaMode === 'docker' && (
                  <div className="space-y-1.5 pt-1 border-t border-border/40">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-low shrink-0">
                        Endpoint URL:
                      </span>
                      <input
                        type="text"
                        value={layaDockerUrl}
                        onChange={(e) => setLayaDockerUrl(e.target.value)}
                        placeholder="http://localhost:8080"
                        className="flex-1 rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                      />
                    </div>
                    <p className="text-[10px] text-low">
                      Build &amp; Run Docker:{' '}
                      <code className="text-normal bg-secondary px-1 py-0.5 rounded font-mono">
                        docker build -t laya-local packages/jev-plugin/docker
                        &amp;&amp; docker run -d -p 8080:8080 laya-local
                      </code>
                    </p>
                    <p className="text-[10px] text-low">
                      🐳 Laya runs inside the container. If Docker is not
                      running, compaction reports the endpoint as unreachable
                      instead of falling back to a local heuristic engine.
                    </p>
                  </div>
                )}

                {layaMode === 'cloud' && (
                  <div className="space-y-1.5 pt-1 border-t border-border/40">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-low shrink-0">
                        Cloud Gateway URL:
                      </span>
                      <input
                        type="text"
                        value={layaCloudUrl}
                        onChange={(e) => setLayaCloudUrl(e.target.value)}
                        placeholder="https://aurapunk.dev/api/memory/v1"
                        className="flex-1 rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                      />
                    </div>
                    <p className="text-[10px] text-low">
                      ☁️ Laya runs on AuraPunk Cloud. Sign in under Settings →
                      Memory to authorize the Desktop; there is no local
                      (embedded) execution mode.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Sub-configuration for Jev API / Vercel AI */}
            {(compactorEngine === 'auto' || compactorEngine === 'jev') && (
              <div className="rounded-sm border border-border/50 bg-panel/60 p-2.5 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium text-normal">
                    <KeyIcon className="size-3 text-warning" />
                    <span>Fast Jev API Connection:</span>
                  </span>
                  <div className="flex items-center rounded-sm bg-secondary p-0.5 text-2xs border border-border/50">
                    <button
                      type="button"
                      onClick={() => setJevProviderMode('vercel-ai')}
                      className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                        jevProviderMode === 'vercel-ai'
                          ? 'bg-panel text-high shadow-xs'
                          : 'text-low hover:text-normal'
                      }`}
                    >
                      ▲ Vercel AI (Beta API Alternative)
                    </button>
                    <button
                      type="button"
                      onClick={() => setJevProviderMode('typesafe')}
                      className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                        jevProviderMode === 'typesafe'
                          ? 'bg-panel text-high shadow-xs'
                          : 'text-low hover:text-normal'
                      }`}
                    >
                      Official Jev API (TypeSafe)
                    </button>
                    <button
                      type="button"
                      onClick={() => setJevProviderMode('embedded')}
                      className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                        jevProviderMode === 'embedded'
                          ? 'bg-panel text-high shadow-xs'
                          : 'text-low hover:text-normal'
                      }`}
                    >
                      ⚡ Local CPU
                    </button>
                  </div>
                </div>

                {jevProviderMode === 'vercel-ai' && (
                  <div className="space-y-1.5 pt-1 border-t border-border/40">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <span className="text-[11px] text-low block mb-0.5">
                          Vercel AI Gateway URL:
                        </span>
                        <input
                          type="text"
                          value={jevVercelUrl}
                          onChange={(e) => setJevVercelUrl(e.target.value)}
                          placeholder="https://api.vercel.ai/v1/fast-jev"
                          className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                        />
                      </div>
                      <div>
                        <span className="text-[11px] text-low block mb-0.5">
                          Vercel AI API Key:
                        </span>
                        <input
                          type="password"
                          value={jevVercelKey}
                          onChange={(e) => setJevVercelKey(e.target.value)}
                          placeholder="••••••••••"
                          className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-low">
                      Routes Fast Jev through Vercel AI Gateway, bypassing the
                      TypeSafe private beta waitlist queue.
                    </p>
                  </div>
                )}

                {jevProviderMode === 'typesafe' && (
                  <div className="space-y-1.5 pt-1 border-t border-border/40">
                    <div>
                      <span className="text-[11px] text-low block mb-0.5">
                        Official Jev Endpoint URL:
                      </span>
                      <input
                        type="text"
                        value={jevTypesafeUrl}
                        onChange={(e) => setJevTypesafeUrl(e.target.value)}
                        placeholder="https://api.typesafe.ai/v1/systemone"
                        className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-low">
                        TypeSafe Jev API Key:
                      </span>
                      <span className="text-[10px] text-low">
                        {compactorEngine === 'auto'
                          ? 'Optional (Falls back to Laya if absent)'
                          : 'Required'}
                      </span>
                    </div>
                    <input
                      type="password"
                      value={jevApiKey}
                      onChange={(e) => setJevApiKey(e.target.value)}
                      placeholder="ts_live_..."
                      className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
                    />
                    <p className="text-[10px] text-low">
                      Uses the official TypeSafe Jev API (
                      <code className="font-mono">jev-latest</code>) directly.
                    </p>
                  </div>
                )}

                {jevProviderMode === 'embedded' && (
                  <p className="text-[10px] text-low pt-1 border-t border-border/40">
                    ⚡ Local CPU only is active — no remote Jev endpoint is
                    called.
                  </p>
                )}
              </div>
            )}

            {/* Guardrails Toggle */}
            <div className="flex items-start gap-2 pt-1">
              <input
                type="checkbox"
                id="laya-guardrails-checkbox"
                checked={layaGuardrailsEnabled}
                onChange={(e) => setLayaGuardrailsEnabled(e.target.checked)}
                className="mt-0.5 accent-brand"
              />
              <label
                htmlFor="laya-guardrails-checkbox"
                className="text-xs text-normal cursor-pointer select-none"
              >
                <span className="font-semibold text-high flex items-center gap-1">
                  <ShieldCheckIcon
                    className="size-3.5 text-emerald-400"
                    weight="bold"
                  />
                  Enable RLCD Autonomous Guardrails (9 Decisions)
                </span>
                <span className="block text-[11px] text-low mt-0.5">
                  Evaluates instructions in &lt;1ms to intercept destructive
                  commands (<code className="font-mono">rm -rf</code>,{' '}
                  <code className="font-mono">git reset --hard</code>) requiring
                  confirmation, detect ambiguous requests, and route tasks.
                </span>
              </label>
            </div>
          </div>

          {/* Threshold Selector with Green Highlight on 85% */}
          <div className="rounded-sm border border-border/70 bg-secondary/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-high flex items-center gap-1.5">
                <ScissorsIcon className="size-3.5 text-warning" weight="bold" />
                <span>
                  {t(
                    'settings.usage.thresholdTitle',
                    'Context Auto-Compaction Threshold'
                  )}
                </span>
              </span>
              <span className="text-[11px] text-low">
                {compactionThreshold === '85'
                  ? '✨ 85% rule active (Recommended)'
                  : compactionThreshold === 'full'
                    ? '⚡ Reactive on error only'
                    : `Triggers at ${compactionThreshold}%`}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 pt-1">
              {THRESHOLD_OPTIONS.map((opt) => {
                const isSelected = compactionThreshold === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setCompactionThreshold(opt.id)}
                    className={`relative flex flex-col items-center justify-center rounded-sm p-2 text-center transition-all border cursor-pointer ${
                      isSelected
                        ? opt.isIdeal
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/50 shadow-xs'
                          : 'border-brand bg-brand/15 text-brand ring-1 ring-brand/50 shadow-xs'
                        : opt.isIdeal
                          ? 'border-emerald-500/50 bg-emerald-500/5 text-normal hover:bg-emerald-500/10'
                          : 'border-border bg-panel hover:bg-secondary text-normal'
                    }`}
                  >
                    {opt.isIdeal && (
                      <span className="absolute -top-2 right-2 rounded-full bg-emerald-600 px-1.5 py-0.2 text-[9px] font-bold text-white uppercase tracking-wider shadow-xs flex items-center gap-0.5">
                        <SparkleIcon className="size-2.5" weight="fill" />
                        Ideal
                      </span>
                    )}
                    <span className="text-sm font-bold">{opt.label}</span>
                    <span className="text-[10px] text-low mt-0.5">
                      {opt.sublabel}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="text-[11px] text-low pt-1">
              {compactionThreshold === '50' && (
                <span className="text-normal font-medium">
                  🎯 Focus (50%): Maintains the model at peak attention and
                  reasoning fidelity (the 40–60% sweet spot), avoiding context
                  degradation on complex code tasks.
                </span>
              )}
              {compactionThreshold === '65' && (
                <span className="text-normal font-medium">
                  🌱 Eco (65%): Compacts frequently to save tokens/credits and
                  keep responses fast and concise.
                </span>
              )}
              {compactionThreshold === '85' && (
                <span className="text-emerald-400 font-medium">
                  ✓ Ideal (85%): Retains a safe 15% margin for long outputs and
                  new file context, preventing slow downs and limit errors.
                </span>
              )}
              {compactionThreshold === '75' && (
                <span>
                  75%: Compacts earlier for sessions that perform heavy
                  multi-file reads in a single turn.
                </span>
              )}
              {compactionThreshold === '95' && (
                <span>
                  95%: Retains maximum context before generating a summary.
                </span>
              )}
              {compactionThreshold === 'full' && (
                <span>
                  Full: No proactive compaction. Waits for the provider to
                  return a token limit error before triggering auto-recovery.
                </span>
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-sm border border-border/60 bg-secondary/40 p-2.5 space-y-1">
              <div className="font-semibold text-normal flex items-center gap-1.5">
                <span>⚡ Auto-Recovery (OpenRouter / APIs)</span>
              </div>
              <p className="text-low text-[11px]">
                When a provider rejects a prompt due to token limits (e.g. 141k
                tokens), the session is compacted automatically and retried
                seamlessly.
              </p>
            </div>

            <div className="rounded-sm border border-border/60 bg-secondary/40 p-2.5 space-y-1">
              <div className="font-semibold text-normal flex items-center gap-1.5">
                <span>🧠 Mem0 Memory Sync</span>
              </div>
              <p className="text-low text-[11px]">
                Before compaction, durable facts and decisions are indexed in
                Mem0. The model can recall details anytime via{' '}
                <code className="text-accent">memory_search</code>.
              </p>
            </div>
          </div>

          <div className="border-t border-border/50 pt-2.5 flex items-center justify-between text-xs text-low">
            <span>
              💡 Tip: You can type{' '}
              <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-normal">
                /compact
              </code>{' '}
              in the chat anytime to trigger manual session compaction.
            </span>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-sm bg-panel px-3 py-1.5 text-sm text-normal ring-1 ring-border hover:text-high"
        >
          {t('settings.usage.refresh', 'Refresh')}
        </button>
      </div>
    </div>
  );
}
