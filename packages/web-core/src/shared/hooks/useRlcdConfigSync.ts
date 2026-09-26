import { useEffect, useState } from 'react';
import type { RlcdConfig } from 'shared/types';
import { makeRequest } from '@/shared/lib/api';
import { reportIntegrationError } from '@/shared/lib/integrationErrors';
import { resolveLayaEndpoint } from '@/shared/components/layaStatus';
import {
  readCloudAccessToken,
  useAbideGuardrailsAction,
  useAbideGuardrailsEnabled,
  useAbideGuardrailsEngine,
  useGuardrailAiAttribution,
  useGuardrailGitOps,
  useGuardrailProtectedFiles,
  useGuardrailSecretLeak,
  useGuardrailSemanticJev,
  useJevApiKey,
  useJevTypesafeUrl,
  useLayaCloudUrl,
  useLayaDockerUrl,
  useLayaGuardrailsEnabled,
  useLayaMode,
  useRlcdMemoryGateEnabled,
} from '@/shared/stores/useUiPreferencesStore';

const SYNC_DEBOUNCE_MS = 600;

/**
 * Mirror the Laya / Jev / guardrail preferences to the backend
 * (`PUT /api/rlcd/config` → `rlcd.toml`).
 *
 * These preferences live in the webview's localStorage, which the backend
 * cannot read — so the guardrail toggles used to be decorative, and nothing
 * server-side (tool-call guardrails, the MCP memory gate) could reach Laya or
 * Jev. Mounted once in the app shell; re-syncs whenever a preference or the
 * AuraPunk Cloud sign-in changes.
 */
export function useRlcdConfigSync(): void {
  const layaMode = useLayaMode();
  const layaDockerUrl = useLayaDockerUrl();
  const layaCloudUrl = useLayaCloudUrl();
  const jevApiKey = useJevApiKey();
  const jevTypesafeUrl = useJevTypesafeUrl();
  const engine = useAbideGuardrailsEngine();
  const abideEnabled = useAbideGuardrailsEnabled();
  const action = useAbideGuardrailsAction();
  const protectedFiles = useGuardrailProtectedFiles();
  const aiAttribution = useGuardrailAiAttribution();
  const secretLeak = useGuardrailSecretLeak();
  const gitOps = useGuardrailGitOps();
  const semanticJev = useGuardrailSemanticJev();
  const layaGuardrails = useLayaGuardrailsEnabled();
  const memoryGate = useRlcdMemoryGateEnabled();

  // The Cloud device token is not in the store; re-read it on sign-in/out.
  const [cloudToken, setCloudToken] = useState(readCloudAccessToken);
  useEffect(() => {
    const refresh = () => setCloudToken(readCloudAccessToken());
    window.addEventListener('aurapunk-cloud-account-changed', refresh);
    return () =>
      window.removeEventListener('aurapunk-cloud-account-changed', refresh);
  }, []);

  useEffect(() => {
    const config: RlcdConfig = {
      engine,
      laya_url:
        resolveLayaEndpoint(layaMode, layaDockerUrl, layaCloudUrl).trim() ||
        null,
      laya_token: layaMode === 'cloud' ? cloudToken : null,
      jev_url: jevTypesafeUrl.trim() || null,
      jev_key: jevApiKey.trim() || null,
      jev_model: null,
      guardrails: {
        enabled: abideEnabled,
        action: action === 'warn' ? 'warn' : 'block',
        protected_files: protectedFiles,
        ai_attribution: aiAttribution,
        secret_leak: secretLeak,
        git_ops: gitOps,
        semantic: layaGuardrails && semanticJev,
      },
      memory_gate: { enabled: memoryGate },
    };
    const timer = window.setTimeout(() => {
      void makeRequest('/api/rlcd/config', {
        method: 'PUT',
        body: JSON.stringify(config),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        })
        .catch((error) =>
          reportIntegrationError(
            engine === 'jev' ? 'jev' : 'laya',
            'sync RLCD settings to backend',
            error
          )
        );
    }, SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    engine,
    layaMode,
    layaDockerUrl,
    layaCloudUrl,
    cloudToken,
    jevTypesafeUrl,
    jevApiKey,
    abideEnabled,
    action,
    protectedFiles,
    aiAttribution,
    secretLeak,
    gitOps,
    semanticJev,
    layaGuardrails,
    memoryGate,
  ]);
}
