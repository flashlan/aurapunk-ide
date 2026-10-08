import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchReExtractStatus,
  fetchUsageSummary,
  providerColor,
  triggerReExtract,
  type Mem0RelevanceSummary,
  type Mem0TokenUsage,
  type ReExtractResponse,
} from './UsageSettingsSection';

const RE_EXTRACT_POLL_MS = 2000;

function TokenBars({ tokens }: { tokens: Mem0TokenUsage }) {
  const { t } = useTranslation('settings');
  return (
    <div className="rounded-sm border border-border bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-2xl font-semibold text-high">
          {tokens.total.toLocaleString()}
        </span>
        <span className="text-xs text-low">
          {t('settings.usage.totalTokens', 'total tokens')}
        </span>
      </div>
      {tokens.days.length === 0 ? (
        <div className="text-sm text-low">
          {t(
            'settings.usage.noTokenData',
            'No extraction tokens recorded yet (mem0 may be offline or the extraction LLM unused).'
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {tokens.days.map((d) => (
              <div key={d.day} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-xs text-low">{d.day}</span>
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
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
            {tokens.providers.map((p) => (
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
  );
}

function relevanceBar(score: number | null): {
  widthPct: number;
  barColor: string;
} {
  if (score == null) return { widthPct: 0, barColor: 'bg-secondary' };
  return {
    widthPct: Math.max(4, Math.round(score * 100)),
    barColor:
      score < 0.3
        ? 'bg-red-500/80'
        : score < 0.6
          ? 'bg-amber-500/80'
          : 'bg-emerald-500/80',
  };
}

function RelevanceBars({ relevance }: { relevance: Mem0RelevanceSummary }) {
  const { t } = useTranslation('settings');
  return (
    <div className="rounded-sm border border-border bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-2xl font-semibold text-high">
          {relevance.total_calls.toLocaleString()}
        </span>
        <span className="text-xs text-low">
          {t('settings.usage.recallCalls', 'memory_search calls')}
          {relevance.total_weak_calls > 0 && (
            <>
              {' · '}
              <span className="text-warning">
                {relevance.total_weak_calls.toLocaleString()}{' '}
                {t('settings.usage.weak', 'weak')}
              </span>
            </>
          )}
        </span>
      </div>
      {relevance.days.length === 0 ? (
        <div className="text-sm text-low">
          {t(
            'settings.usage.noRelevanceData',
            'No recall calls recorded yet this server run (in-memory only — resets on restart).'
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {relevance.days.map((d) => {
            const score = d.avg_top_score;
            const { widthPct, barColor } = relevanceBar(score);
            return (
              <div key={d.day} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-xs text-low">{d.day}</span>
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
  );
}

/**
 * Memory usage statistics, shown in Settings → Memory: what extraction costs
 * and how well recall scores. The graph itself lives in the `graphify` add-on.
 */
export function MemoryUsageStats() {
  const { t } = useTranslation('settings');
  const [summary, setSummary] = useState<{
    mem0_tokens: Mem0TokenUsage;
    mem0_relevance: Mem0RelevanceSummary;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reExtractUser, setReExtractUser] = useState('');
  const [reExtractBusy, setReExtractBusy] = useState(false);
  const [reExtractResult, setReExtractResult] =
    useState<ReExtractResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchUsageSummary();
      setSummary({
        mem0_tokens: next.mem0_tokens,
        mem0_relevance: next.mem0_relevance,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memory usage');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReExtract = async () => {
    const userId = reExtractUser.trim() || 'default';
    setReExtractBusy(true);
    setError(null);
    try {
      let res = await triggerReExtract(userId);
      setReExtractResult(res);
      // One LLM call per memory: a repository takes minutes, so the server runs
      // it in the background and we poll until it settles.
      while (res.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, RE_EXTRACT_POLL_MS));
        res = await fetchReExtractStatus(userId);
        setReExtractResult(res);
      }
      if (res.status === 'failed') {
        setError(res.error ?? 'Re-extraction failed');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-extraction failed');
    } finally {
      setReExtractBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-high">
        {t('settings.memory.usageTitle', 'Memory usage')}
      </h3>
      {error && (
        <div className="rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      <section>
        <h4 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.mem0Tokens', 'mem0 extraction tokens')}
        </h4>
        {summary && <TokenBars tokens={summary.mem0_tokens} />}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.mem0Relevance', 'mem0 recall relevance')}
        </h4>
        {summary && <RelevanceBars relevance={summary.mem0_relevance} />}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-medium text-high">
          {t('settings.usage.reExtract', 'Re-extract graph entities')}
        </h4>
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
              {reExtractResult.status === 'running' &&
                `${reExtractResult.processed}/${reExtractResult.scanned} · `}
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
    </div>
  );
}
