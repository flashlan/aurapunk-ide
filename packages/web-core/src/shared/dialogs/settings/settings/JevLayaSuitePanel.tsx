import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  LightningIcon,
  ShieldCheckIcon,
  ChatCircleTextIcon,
  DatabaseIcon,
  CloudIcon,
  CheckCircleIcon,
} from '@phosphor-icons/react';
import {
  useAbideGuardrailsEnabled,
  useSetAbideGuardrailsEnabled,
  useAbideGuardrailsEngine,
  useSetAbideGuardrailsEngine,
  useAbideGuardrailsAction,
  useSetAbideGuardrailsAction,
  useCompactorEngine,
  useSetCompactorEngine,
  useCompactionThreshold,
  useSetCompactionThreshold,
  useJevProviderMode,
  useSetJevProviderMode,
  useJevVercelUrl,
  useSetJevVercelUrl,
  useJevVercelKey,
  useSetJevVercelKey,
  type CompactorEngineType,
  type CompactionThreshold,
} from '@/shared/stores/useUiPreferencesStore';
import { SettingsCheckbox } from './SettingsComponents';

export const JevLayaSuitePanel: React.FC = () => {
  const { t } = useTranslation('settings');

  // Abide Guardrails
  const abideEnabled = useAbideGuardrailsEnabled();
  const setAbideEnabled = useSetAbideGuardrailsEnabled();
  const abideEngine = useAbideGuardrailsEngine();
  const setAbideEngine = useSetAbideGuardrailsEngine();
  const abideAction = useAbideGuardrailsAction();
  const setAbideAction = useSetAbideGuardrailsAction();

  // Compactor
  const compactorEngine = useCompactorEngine();
  const setCompactorEngine = useSetCompactorEngine();
  const compactionThreshold = useCompactionThreshold();
  const setCompactionThreshold = useSetCompactionThreshold();
  const compactorActive = compactorEngine !== 'disabled';

  // Jev / Vercel AI
  const jevMode = useJevProviderMode();
  const setJevMode = useSetJevProviderMode();
  const jevVercelUrl = useJevVercelUrl();
  const setJevVercelUrl = useSetJevVercelUrl();
  const jevVercelKey = useJevVercelKey();
  const setJevVercelKey = useSetJevVercelKey();

  return (
    <div className="space-y-6 pt-2 text-normal">
      {/* Overview Status Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand/40 bg-secondary/50 p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-sm bg-brand/20 text-brand">
            <LightningIcon className="size-5" weight="fill" />
          </div>
          <div>
            <div className="text-sm font-medium text-high flex items-center gap-1.5">
              <span>Fast Jev &amp; Laya AI Suite</span>
              <span className="rounded-xs bg-emerald-500/20 px-1.5 py-0.5 text-2xs font-semibold text-emerald-400">
                0 Tokens / Local CPU
              </span>
            </div>
            <div className="text-xs text-low">
              Unified control center for local AST decisions, Abide rule
              guardrails, and context auto-compaction.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-low">
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircleIcon className="size-3.5" weight="fill" />
            Laya Engine &lt;1ms
          </span>
        </div>
      </div>

      {/* Module 1: Abide Rule Guardrails */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-brand" weight="bold" />
            <div>
              <div className="text-sm font-medium text-high">
                {t(
                  'settings.abide.title',
                  'Active Rule Guardrails (Abide Engine)'
                )}
              </div>
              <div className="text-2xs text-low">
                {t(
                  'settings.abide.desc',
                  'Enforces AGENTS.md rules on every code edit/diff. Self-heals violations in the same turn.'
                )}
              </div>
            </div>
          </div>
          <SettingsCheckbox
            id="abide-enabled-toggle"
            label={abideEnabled ? 'Active' : 'Disabled'}
            checked={abideEnabled}
            onChange={setAbideEnabled}
          />
        </div>

        {abideEnabled && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-2xs font-medium text-low mb-1">
                  Guardrail Evaluation Engine:
                </label>
                <div className="flex flex-wrap rounded-sm bg-secondary p-0.5 text-2xs border border-border/60">
                  <button
                    type="button"
                    onClick={() => setAbideEngine('adaptive')}
                    className={`flex-1 rounded-xs px-2 py-1 font-medium transition-colors ${
                      abideEngine === 'adaptive'
                        ? 'bg-panel text-high shadow-xs'
                        : 'text-low hover:text-normal'
                    }`}
                  >
                    🔄 Adaptive (Laya + Jev)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbideEngine('laya')}
                    className={`flex-1 rounded-xs px-2 py-1 font-medium transition-colors ${
                      abideEngine === 'laya'
                        ? 'bg-panel text-high shadow-xs'
                        : 'text-low hover:text-normal'
                    }`}
                  >
                    ⚡ Laya (Local CPU)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbideEngine('jev')}
                    className={`flex-1 rounded-xs px-2 py-1 font-medium transition-colors ${
                      abideEngine === 'jev'
                        ? 'bg-panel text-high shadow-xs'
                        : 'text-low hover:text-normal'
                    }`}
                  >
                    ▲ Fast Jev (Vercel AI)
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-2xs font-medium text-low mb-1">
                  Enforcement Action:
                </label>
                <div className="flex rounded-sm bg-secondary p-0.5 text-2xs border border-border/60">
                  <button
                    type="button"
                    onClick={() => setAbideAction('block')}
                    className={`flex-1 rounded-xs px-2 py-1 font-medium transition-colors ${
                      abideAction === 'block'
                        ? 'bg-panel text-high shadow-xs'
                        : 'text-low hover:text-normal'
                    }`}
                  >
                    🛑 Block &amp; Repair In-Turn
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbideAction('warn')}
                    className={`flex-1 rounded-xs px-2 py-1 font-medium transition-colors ${
                      abideAction === 'warn'
                        ? 'bg-panel text-high shadow-xs'
                        : 'text-low hover:text-normal'
                    }`}
                  >
                    ⚠️ Warn Only
                  </button>
                </div>
              </div>
            </div>

            <p className="text-2xs text-low">
              • <strong>Laya Local</strong> evaluates AST &amp; protected paths
              (e.g. shared/types.ts, AI attribution trailers, raw secrets) in
              &lt;1ms on local CPU with 0 tokens.
              <br />• <strong>Fast Jev</strong> evaluates semantic architectural
              rules via Vercel AI Gateway (~300ms).
            </p>
          </div>
        )}
      </div>

      {/* Module 2: Context Auto-Compaction */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <ChatCircleTextIcon className="size-5 text-brand" weight="bold" />
            <div>
              <div className="text-sm font-medium text-high">
                {t(
                  'settings.compactor.title',
                  'Chat Auto-Compaction (/compress)'
                )}
              </div>
              <div className="text-2xs text-low">
                {t(
                  'settings.compactor.desc',
                  'Isolates conversation history with milestone markers to keep model input fresh.'
                )}
              </div>
            </div>
          </div>
          <SettingsCheckbox
            id="compactor-auto-toggle"
            label={compactorActive ? 'Auto Enabled' : 'Disabled'}
            checked={compactorActive}
            onChange={(checked) =>
              setCompactorEngine(checked ? 'auto' : 'disabled')
            }
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
          <div>
            <label className="block text-2xs font-medium text-low mb-1">
              Compaction Engine:
            </label>
            <select
              value={compactorEngine}
              onChange={(e) =>
                setCompactorEngine(e.target.value as CompactorEngineType)
              }
              className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal"
            >
              <option value="auto">🔄 Auto (Laya with Jev Fallback)</option>
              <option value="laya">⚡ Laya Local (0 Tokens, &lt;1ms)</option>
              <option value="jev">▲ Fast Jev (Vercel AI / TypeSafe)</option>
              <option value="disabled">🚫 Disabled</option>
            </select>
          </div>

          <div>
            <label className="block text-2xs font-medium text-low mb-1">
              Context Trigger Threshold:
            </label>
            <select
              value={compactionThreshold}
              onChange={(e) =>
                setCompactionThreshold(e.target.value as CompactionThreshold)
              }
              className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal"
            >
              <option value="50">50% Window Fill</option>
              <option value="65">65% Window Fill</option>
              <option value="75">75% Window Fill</option>
              <option value="85">85% Window Fill (Recommended)</option>
              <option value="95">95% Window Fill (Aggressive)</option>
              <option value="full">Full / Manual Only</option>
            </select>
          </div>
        </div>
      </div>

      {/* Module 3: Vercel AI Gateway Configuration */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <CloudIcon className="size-5 text-brand" weight="bold" />
            <div>
              <div className="text-sm font-medium text-high">
                Fast Jev Cloud Connection (Vercel AI Alternative)
              </div>
              <div className="text-2xs text-low">
                Bypasses the TypeSafe private beta waitlist queue via Vercel AI
                Gateway.
              </div>
            </div>
          </div>
          <div className="flex items-center rounded-sm bg-secondary p-0.5 text-2xs border border-border/60">
            <button
              type="button"
              onClick={() => setJevMode('vercel-ai')}
              className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                jevMode === 'vercel-ai'
                  ? 'bg-panel text-high shadow-xs'
                  : 'text-low hover:text-normal'
              }`}
            >
              ▲ Vercel AI
            </button>
            <button
              type="button"
              onClick={() => setJevMode('embedded')}
              className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                jevMode === 'embedded'
                  ? 'bg-panel text-high shadow-xs'
                  : 'text-low hover:text-normal'
              }`}
            >
              ⚡ Local CPU Only
            </button>
          </div>
        </div>

        {jevMode === 'vercel-ai' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
            <div>
              <span className="text-2xs text-low block mb-1">
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
              <span className="text-2xs text-low block mb-1">
                Vercel AI Key:
              </span>
              <input
                type="password"
                value={jevVercelKey}
                onChange={(e) => setJevVercelKey(e.target.value)}
                placeholder="••••••••••••••••"
                className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
              />
            </div>
          </div>
        )}
      </div>

      {/* Module 4: Cloud Laya & Quotas */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-2.5">
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-5 text-brand" weight="bold" />
            <div>
              <div className="text-sm font-medium text-high">
                Mem0 Cloud &amp; Laya Quota Tiers
              </div>
              <div className="text-2xs text-low">
                Hosted Laya extraction quota for cloud workspaces (sd-2).
              </div>
            </div>
          </div>
          <span className="rounded-xs bg-brand/20 px-2 py-0.5 text-2xs font-semibold text-brand">
            Free Tier (100 ops/mo)
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1">
          <span className="text-2xs text-low">
            • <strong>Free Accounts</strong>: 100 Laya Cloud extraction &amp;
            search operations / month.
            <br />• <strong>Pro Accounts</strong>: 10,000 operations / month
            with priority low-latency queue.
          </span>
          <span className="text-2xs text-emerald-400 font-medium">
            Local self-hosted Docker all-in-one is always unlimited.
          </span>
        </div>
      </div>
    </div>
  );
};
