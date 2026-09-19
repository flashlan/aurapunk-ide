import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateMem0ExtractionProvider } from '@/shared/lib/mem0ExtractionProvider';
import {
  LightningIcon,
  ShieldCheckIcon,
  ChatCircleTextIcon,
  DatabaseIcon,
  CloudIcon,
  CheckCircleIcon,
  FileCodeIcon,
  UserCircleGearIcon,
  KeyIcon,
  GitForkIcon,
  SparkleIcon,
} from '@phosphor-icons/react';
import {
  useAbideGuardrailsEnabled,
  useSetAbideGuardrailsEnabled,
  useAbideGuardrailsEngine,
  useSetAbideGuardrailsEngine,
  useAbideGuardrailsAction,
  useSetAbideGuardrailsAction,
  useGuardrailProtectedFiles,
  useSetGuardrailProtectedFiles,
  useGuardrailAiAttribution,
  useSetGuardrailAiAttribution,
  useGuardrailSecretLeak,
  useSetGuardrailSecretLeak,
  useGuardrailGitOps,
  useSetGuardrailGitOps,
  useGuardrailSemanticJev,
  useSetGuardrailSemanticJev,
  useCompactorEngine,
  useSetCompactorEngine,
  usePrimaryEngine,
  useSetPrimaryEngine,
  primaryEngineMapping,
  useCompactionThreshold,
  useSetCompactionThreshold,
  useJevApiKey,
  useSetJevApiKey,
  useJevTypesafeUrl,
  useSetJevTypesafeUrl,
  type CompactorEngineType,
  type CompactionThreshold,
  type PrimaryEngine,
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

  // Individual Feature Checkboxes
  const guardrailProtectedFiles = useGuardrailProtectedFiles();
  const setGuardrailProtectedFiles = useSetGuardrailProtectedFiles();
  const guardrailAiAttribution = useGuardrailAiAttribution();
  const setGuardrailAiAttribution = useSetGuardrailAiAttribution();
  const guardrailSecretLeak = useGuardrailSecretLeak();
  const setGuardrailSecretLeak = useSetGuardrailSecretLeak();
  const guardrailGitOps = useGuardrailGitOps();
  const setGuardrailGitOps = useSetGuardrailGitOps();
  const guardrailSemanticJev = useGuardrailSemanticJev();
  const setGuardrailSemanticJev = useSetGuardrailSemanticJev();

  // Compactor
  const compactorEngine = useCompactorEngine();
  const setCompactorEngine = useSetCompactorEngine();
  const compactionThreshold = useCompactionThreshold();
  const setCompactionThreshold = useSetCompactionThreshold();
  const compactorActive = compactorEngine !== 'disabled';

  // Jev (TypeSafe)
  const jevApiKey = useJevApiKey();
  const setJevApiKey = useSetJevApiKey();
  const jevTypesafeUrl = useJevTypesafeUrl();
  const setJevTypesafeUrl = useSetJevTypesafeUrl();

  // Central engine selector
  const primaryEngine = usePrimaryEngine();
  const setPrimaryEngine = useSetPrimaryEngine();
  const [primaryBusy, setPrimaryBusy] = useState(false);
  const [primaryNotice, setPrimaryNotice] = useState<string | null>(null);

  const handlePrimaryEngine = async (engine: PrimaryEngine) => {
    setPrimaryEngine(engine);
    setPrimaryNotice(null);
    try {
      setPrimaryBusy(true);
      await updateMem0ExtractionProvider(
        primaryEngineMapping(engine).mem0Provider
      );
      setPrimaryNotice(
        `Applied to compactor, guardrails and mem0 extraction (${engine}).`
      );
    } catch (e) {
      setPrimaryNotice(
        `Compactor and guardrails updated, but the mem0 extraction provider could not be changed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    } finally {
      setPrimaryBusy(false);
    }
  };

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
                Docker / Cloud
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
            Laya Engine (Docker / Cloud)
          </span>
        </div>
      </div>

      {/* Central Jev/Laya engine selector */}
      <div className="rounded-md border border-brand/60 bg-brand/5 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-high">
              Primary Jev/Laya engine
            </div>
            <div className="text-2xs text-low">
              One choice for every surface — context compaction, Abide
              guardrails and mem0 extraction. Individual settings below can
              still be overridden.
            </div>
          </div>
          <div className="flex items-center rounded-sm bg-secondary p-0.5 text-2xs border border-border">
            {(['auto', 'jev', 'laya'] as const).map((engine) => (
              <button
                key={engine}
                type="button"
                disabled={primaryBusy}
                onClick={() => void handlePrimaryEngine(engine)}
                className={`rounded-xs px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${
                  primaryEngine === engine
                    ? 'bg-panel text-high shadow-xs'
                    : 'text-low hover:text-normal'
                }`}
              >
                {engine === 'auto'
                  ? 'Auto (Jev + Laya)'
                  : engine === 'jev'
                    ? 'Jev'
                    : 'Laya'}
              </button>
            ))}
          </div>
        </div>
        {primaryNotice && (
          <div className="rounded-sm border border-border/50 bg-panel/60 px-2.5 py-1.5 text-2xs text-low">
            {primaryNotice}
          </div>
        )}
      </div>

      {/* Module 1: Abide Rule Guardrails Engine */}
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
                    🐳 Laya (Docker / Cloud)
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
                    ▲ Fast Jev (TypeSafe)
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
              • <strong>Laya</strong> evaluates AST &amp; protected paths via a
              Docker container or AuraPunk Cloud — never embedded in-process.
              <br />• <strong>Fast Jev</strong> evaluates semantic architectural
              rules via the TypeSafe Jev API (~300ms).
            </p>
          </div>
        )}
      </div>

      {/* Module 2: Specific Rule Activation Checkbox Matrix */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-3">
        <div className="border-b border-border/60 pb-2">
          <div className="text-sm font-medium text-high flex items-center gap-2">
            <ShieldCheckIcon
              className="size-4 text-emerald-400"
              weight="bold"
            />
            <span>Matriz de Ativação de Regras e Guardrails</span>
          </div>
          <div className="text-2xs text-low">
            Ative ou desative individualmente cada guardrail do sistema conforme
            sua necessidade.
          </div>
        </div>

        <div className="divide-y divide-border/40">
          {/* Rule 1: Bloqueio de arquivos protegidos */}
          <div className="py-2.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <FileCodeIcon
                className="size-4.5 text-brand mt-0.5 shrink-0"
                weight="bold"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-normal flex items-center gap-1.5">
                  <span>Bloqueio imediato de arquivos protegidos</span>
                  <span className="rounded-xs bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-mono text-emerald-400">
                    Laya &lt;1ms
                  </span>
                </div>
                <p className="text-2xs text-low">
                  Impede edições manuais em arquivos gerados ou de tipos
                  protegidos (ex: <code>shared/types.ts</code>). Força a
                  regeneração através das ferramentas oficiais.
                </p>
              </div>
            </div>
            <SettingsCheckbox
              id="guardrail-protected-files"
              label=""
              checked={guardrailProtectedFiles}
              onChange={setGuardrailProtectedFiles}
            />
          </div>

          {/* Rule 2: Bloqueio de trailers de co-autoria de IA */}
          <div className="py-2.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <UserCircleGearIcon
                className="size-4.5 text-brand mt-0.5 shrink-0"
                weight="bold"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-normal flex items-center gap-1.5">
                  <span>Bloqueio de trailers de co-autoria de IA</span>
                  <span className="rounded-xs bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-mono text-emerald-400">
                    Laya &lt;1ms
                  </span>
                </div>
                <p className="text-2xs text-low">
                  Remove e bloqueia menções de co-autoria e trailers de
                  assistentes (ex: <code>Co-Authored-By: Claude</code>,{' '}
                  <code>Generated by AI</code>) mantendo a autoria limpa.
                </p>
              </div>
            </div>
            <SettingsCheckbox
              id="guardrail-ai-attribution"
              label=""
              checked={guardrailAiAttribution}
              onChange={setGuardrailAiAttribution}
            />
          </div>

          {/* Rule 3: Bloqueio de chaves/segredos expostos */}
          <div className="py-2.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <KeyIcon
                className="size-4.5 text-amber-400 mt-0.5 shrink-0"
                weight="bold"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-normal flex items-center gap-1.5">
                  <span>Bloqueio de chaves e segredos expostos</span>
                  <span className="rounded-xs bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-mono text-emerald-400">
                    Laya &lt;1ms
                  </span>
                </div>
                <p className="text-2xs text-low">
                  Impede que chaves de API ao vivo (<code>ts_live_...</code>,{' '}
                  <code>sk-...</code>, tokens) sejam commitadas diretamente em
                  arquivos do repositório.
                </p>
              </div>
            </div>
            <SettingsCheckbox
              id="guardrail-secret-leak"
              label=""
              checked={guardrailSecretLeak}
              onChange={setGuardrailSecretLeak}
            />
          </div>

          {/* Rule 4: Bloqueio de operações perigosas em completion */}
          <div className="py-2.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <GitForkIcon
                className="size-4.5 text-red-400 mt-0.5 shrink-0"
                weight="bold"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-normal flex items-center gap-1.5">
                  <span>Bloqueio de comandos git manuais no completion</span>
                  <span className="rounded-xs bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-mono text-emerald-400">
                    Laya &lt;1ms
                  </span>
                </div>
                <p className="text-2xs text-low">
                  Bloqueia execuções manuais de <code>git push</code>,{' '}
                  <code>git merge</code> ou rebase fora do Integration Guard
                  Protocol oficial.
                </p>
              </div>
            </div>
            <SettingsCheckbox
              id="guardrail-git-ops"
              label=""
              checked={guardrailGitOps}
              onChange={setGuardrailGitOps}
            />
          </div>

          {/* Rule 5: Avaliação semântica via Jev com limiar calibrado */}
          <div className="py-2.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <SparkleIcon
                className="size-4.5 text-brand mt-0.5 shrink-0"
                weight="bold"
              />
              <div className="space-y-0.5">
                <div className="text-xs font-medium text-normal flex items-center gap-1.5">
                  <span>Avaliação semântica via Fast Jev (TypeSafe)</span>
                  <span className="rounded-xs bg-brand/20 px-1.5 py-0.2 text-[10px] font-mono text-brand">
                    Jev ~300ms
                  </span>
                </div>
                <p className="text-2xs text-low">
                  Envia diffs e regras semânticas complexas (ex: regras de
                  arquitetura, tratamento de erros, ausência de abstrações de
                  uso único) para o modelo de decisão Jev com limiar calibrado.
                </p>
              </div>
            </div>
            <SettingsCheckbox
              id="guardrail-semantic-jev"
              label=""
              checked={guardrailSemanticJev}
              onChange={setGuardrailSemanticJev}
            />
          </div>
        </div>
      </div>

      {/* Module 3: Context Auto-Compaction */}
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
              <option value="laya">🐳 Laya (Docker / Cloud)</option>
              <option value="jev">▲ Fast Jev (TypeSafe)</option>
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

      {/* Module 4: Jev API Connection (Official TypeSafe) */}
      <div className="rounded-md border border-border/80 bg-panel p-4 space-y-3">
        <div className="border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <CloudIcon className="size-5 text-brand" weight="bold" />
            <div>
              <div className="text-sm font-medium text-high">
                Fast Jev API Connection
              </div>
              <div className="text-2xs text-low">
                Jev is TypeSafe's System-1 evaluation model; compaction calls
                the official TypeSafe API directly.
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <span className="text-2xs text-low block mb-0.5">
              Jev Endpoint URL:
            </span>
            <input
              type="text"
              value={jevTypesafeUrl}
              onChange={(e) => setJevTypesafeUrl(e.target.value)}
              placeholder="https://api.typesafe.ai/v1/systemone"
              className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
            />
          </div>
          <div>
            <span className="text-2xs text-low block mb-0.5">
              TypeSafe API Key:
            </span>
            <input
              type="password"
              value={jevApiKey}
              onChange={(e) => setJevApiKey(e.target.value)}
              placeholder="apikey_..."
              className="w-full rounded-sm border border-border bg-secondary px-2 py-1 text-xs text-normal font-mono"
            />
          </div>
        </div>

        <p className="text-[10px] text-low">
          Direct calls to the official TypeSafe Jev API. Without a key, the
          compactor's Auto mode falls back to Laya.
        </p>
      </div>

      {/* Module 5: Cloud Laya & Quotas */}
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
