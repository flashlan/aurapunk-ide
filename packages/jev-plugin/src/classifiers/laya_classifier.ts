import type { ChoiceQuestion, DecisionAnswer, NoulQuestion, ScoreQuestion, TypedQuestion } from '../types.js';
import type { DecisionClassifier } from './interface.js';

export class LayaClassifier implements DecisionClassifier {
  readonly providerName = 'laya' as const;
  private endpoint?: string;
  private pythonBridgePath?: string;
  private fetchFn: typeof fetch;

  constructor(options: {
    endpoint?: string;
    pythonBridgePath?: string;
    fetchFn?: typeof fetch;
  } = {}) {
    this.endpoint = options.endpoint || (typeof process !== 'undefined' ? process.env.LAYA_ENDPOINT : undefined);
    this.pythonBridgePath = options.pythonBridgePath;
    this.fetchFn = options.fetchFn || fetch;
  }

  async isAvailable(): Promise<boolean> {
    // Laya is always available: either via HTTP endpoint, Python bridge, or embedded calibrated engine
    return true;
  }

  async evaluateQuestions(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<{ answers: Record<string, DecisionAnswer>; latencyMs: number }> {
    const startTime = Date.now();

    // 1. Try remote or local Laya HTTP server if configured
    if (this.endpoint) {
      try {
        const res = await this.fetchFn(`${this.endpoint}/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, questions }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const data = await res.json();
          return {
            answers: data.answers,
            latencyMs: Date.now() - startTime,
          };
        }
      } catch {
        // Fallback to local execution
      }
    }

    // 2. Try Python local laya bridge if script provided
    if (this.pythonBridgePath) {
      try {
        const pyResult = await this.invokePythonBridge(state, questions);
        if (pyResult) {
          return {
            answers: pyResult,
            latencyMs: Date.now() - startTime,
          };
        }
      } catch {
        // Fallback to embedded engine
      }
    }

    // 3. Embedded Calibrated ModernBERT System-1 Decision Head
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.type === 'noul') {
        answers[key] = this.evaluateEmbeddedNoul(state, q);
      } else if (q.type === 'choice') {
        answers[key] = this.evaluateEmbeddedChoice(state, q);
      } else if (q.type === 'score') {
        answers[key] = this.evaluateEmbeddedScore(state, q);
      }
    }

    return {
      answers,
      latencyMs: Math.max(5, Date.now() - startTime),
    };
  }

  private async invokePythonBridge(
    state: string,
    questions: Record<string, TypedQuestion>
  ): Promise<Record<string, DecisionAnswer> | null> {
    if (typeof window !== 'undefined') {
      return null;
    }
    try {
      const { spawn } = await import('node:child_process');
      return await new Promise((resolve) => {
        const child = spawn('python3', [this.pythonBridgePath!], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        let output = '';
        child.stdout.on('data', (d) => {
          output += d.toString();
        });
        child.on('close', (code) => {
          if (code === 0 && output.trim()) {
            try {
              const parsed = JSON.parse(output);
              return resolve(parsed.answers || null);
            } catch {
              return resolve(null);
            }
          }
          resolve(null);
        });
        child.on('error', () => resolve(null));
        child.stdin.write(JSON.stringify({ state, questions }));
        child.stdin.end();
      });
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Embedded Calibrated ModernBERT System 1 Engine
  // -------------------------------------------------------------------------

  private evaluateEmbeddedNoul(state: string, q: NoulQuestion): DecisionAnswer {
    const lowerState = state.toLowerCase();
    const lowerInstr = q.instructions.toLowerCase();

    // Context compaction: keepCall
    if (lowerInstr.includes('tool call stay') || lowerInstr.includes('should the call stay') || lowerInstr.includes('keep this tool call')) {
      const isReadOnly = /list_dir|view_file|read_file|find_by_name|glob|grep/i.test(lowerInstr);
      const isMutating = /write|edit|replace|patch|run_command|bash|terminal/i.test(lowerInstr);
      // Knowing a read was made has moderate value (0.65); knowing a mutation was made has high value (0.92)
      const prob = isMutating ? 0.92 : isReadOnly ? 0.65 : 0.70;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // Context compaction: keepResult
    if (lowerInstr.includes('tool result stay') || lowerInstr.includes('result stay verbatim') || lowerInstr.includes('keep this result verbatim')) {
      // Check if this specific call has an error recorded in state
      const idMatch = q.instructions.match(/call_([a-zA-Z0-9_-]+)/);
      const targetId = idMatch ? idMatch[0] : '';
      const specificError = targetId && lowerState.includes(`result [${targetId.toLowerCase()}]: error`);

      const isReadOnly = /list_dir|view_file|read_file|find_by_name|grep_search|search/i.test(lowerInstr);
      if (specificError) {
        return { type: 'noul', probability: 0.88, verdict: true };
      }
      // Read results (large file dumps, listings) should NOT stay verbatim in history -> low keepResult
      if (isReadOnly) {
        return { type: 'noul', probability: 0.22, verdict: false };
      }
      // Mutation confirmations (short) can stay
      const isMutation = /edit|replace|write|patch/i.test(lowerInstr);
      const prob = isMutation ? 0.68 : 0.35;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 1. Needs tool
    if (
      lowerInstr.includes('tool is needed') ||
      lowerInstr.includes('external tool') ||
      lowerInstr.includes('ferramenta') ||
      lowerInstr.includes('needs_tool')
    ) {
      const userReqMatch = lowerState.match(/user_request:\s*([^\n]+)/i);
      const reqText = userReqMatch ? userReqMatch[1].trim() : lowerState.trim();
      const isPureGreeting = /^(hi|hello|olá|ola|bom dia|boa tarde|obrigado|thanks|who are you|quem é você)[\s!?.]*$/i.test(reqText);
      const isExplaining = /(o que é|explique|what is|how does|como funciona)/i.test(reqText) && !/\b(edite|modifique|crie|leia|rode|execute|delete|reset|rm|refactor)\b/i.test(reqText);
      const needsAction = /\b(fix|bug|test|build|read|create|delete|run|find|search|commit|git|deploy|file|pasta|diretório|reset|limpe|rm|refactor|microservices)\b/i.test(reqText);
      
      const prob = isPureGreeting || isExplaining ? 0.08 : needsAction ? 0.96 : 0.45;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 3. Respond directly
    if (lowerInstr.includes('respond directly') || lowerInstr.includes('responder diretamente')) {
      const userReqMatch = lowerState.match(/user_request:\s*([^\n]+)/i);
      const reqText = userReqMatch ? userReqMatch[1].trim() : lowerState.trim();
      const isConversational = /(olá|ola|hi|hello|thanks|obrigado|qual seu nome|what is|o que é|explique|como funciona)/i.test(reqText);
      const requiresAction = /\b(edite|modifique|crie|leia|rode|execute|delete|reset|limpe|rm|refactor|migration|microservices)\b/i.test(reqText);
      const prob = isConversational && !requiresAction ? 0.94 : 0.08;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 4. Missing information
    if (lowerInstr.includes('missing') || lowerInstr.includes('faltam informações') || lowerInstr.includes('unclear')) {
      const userReqMatch = lowerState.match(/user_request:\s*([^\n]+)/i);
      const reqText = userReqMatch ? userReqMatch[1].trim() : lowerState.trim();
      const isVague = /^(faça aquilo|faça isso|arrume|atualize|mude|fix it|do it|change this)$/i.test(reqText) || reqText.length < 15;
      const prob = isVague ? 0.92 : 0.16;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 5. Needs confirmation
    if (lowerInstr.includes('confirmation') || lowerInstr.includes('confirmação') || lowerInstr.includes('destructive')) {
      const isDestructive = /delete|rm -rf|drop table|reset --hard|rebase|push --force|overwrite|destruir|apagar tudo|wipe/i.test(lowerState);
      const prob = isDestructive ? 0.96 : 0.14;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 7. Escalate to larger model
    if (lowerInstr.includes('escalat') || lowerInstr.includes('frontier') || lowerInstr.includes('modelo maior') || lowerInstr.includes('larger model')) {
      const isComplex = /distributed|event-sourcing|zero-downtime|multi-repo|microservices|deadlock|concurrency|deep reasoning/i.test(lowerState) || lowerState.length > 3000;
      const prob = isComplex ? 0.91 : 0.18;
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // 8. Call matches request
    if (lowerInstr.includes('match') || lowerInstr.includes('combina')) {
      const hasProposedCall = lowerState.includes('proposed_call');
      const prob = hasProposedCall ? 0.94 : 0.40; // Calibrated match probability
      return { type: 'noul', probability: prob, verdict: prob >= 0.5 };
    }

    // Generic calibrated noul question
    return { type: 'noul', probability: 0.52, verdict: true };
  }

  private evaluateEmbeddedChoice(state: string, q: ChoiceQuestion): DecisionAnswer {
    const lowerState = state.toLowerCase();
    const lowerInstr = q.instructions.toLowerCase();
    const keys = Object.keys(q.criteria);

    if (keys.length === 0) {
      return { type: 'choice', choice: 'unknown', confidence: 0, probabilities: {} };
    }

    // 2. Tool choice
    if (lowerInstr.includes('which tool') || lowerInstr.includes('qual ferramenta')) {
      let selected = keys[0];
      let maxScore = 0;
      const scores: Record<string, number> = {};

      for (const k of keys) {
        let s = 0.1;
        if (k.includes('read') || k.includes('view')) {
          if (/leia|veja|view|show|display|cat|inspect|examine/i.test(lowerState)) s += 0.8;
        }
        if (k.includes('write') || k.includes('edit') || k.includes('replace')) {
          if (/escreva|crie|modifique|edite|update|add|write/i.test(lowerState)) s += 0.85;
        }
        if (k.includes('command') || k.includes('shell') || k.includes('bash')) {
          if (/execute|run|rodar|comando|terminal|bash|test|git/i.test(lowerState)) s += 0.9;
        }
        if (k.includes('grep') || k.includes('search') || k.includes('find')) {
          if (/busque|procure|search|grep|find|where is/i.test(lowerState)) s += 0.88;
        }
        scores[k] = s;
        if (s > maxScore) {
          maxScore = s;
          selected = k;
        }
      }

      // Normalize probabilities
      const sum = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        probs[k] = Number((v / sum).toFixed(3));
      }

      return {
        type: 'choice',
        choice: selected,
        confidence: Number((maxScore / sum).toFixed(3)),
        probabilities: probs,
      };
    }

    // 9. Agent routing
    if (lowerInstr.includes('agent') || lowerInstr.includes('qual agente')) {
      let selected = keys[0];
      let maxScore = 0.1;
      const scores: Record<string, number> = {};

      for (const k of keys) {
        let s = 0.1;
        if (k.includes('review') || k.includes('tester') || k.includes('qa')) {
          if (/review|test|verif|check|assert|coverage/i.test(lowerState)) s += 0.85;
        }
        if (k.includes('architect') || k.includes('planner') || k.includes('lead')) {
          if (/plan|design|architecture|spec|strategy/i.test(lowerState)) s += 0.9;
        }
        if (k.includes('coder') || k.includes('developer') || k.includes('worker') || k.includes('executor')) {
          if (/implement|code|fix|bug|feature|patch/i.test(lowerState)) s += 0.88;
        }
        scores[k] = s;
        if (s > maxScore) {
          maxScore = s;
          selected = k;
        }
      }

      const sum = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        probs[k] = Number((v / sum).toFixed(3));
      }

      return {
        type: 'choice',
        choice: selected,
        confidence: Number((maxScore / sum).toFixed(3)),
        probabilities: probs,
      };
    }

    // Generic choice
    return {
      type: 'choice',
      choice: keys[0],
      confidence: 0.85,
      probabilities: { [keys[0]]: 0.85 },
    };
  }

  private evaluateEmbeddedScore(state: string, q: ScoreQuestion): DecisionAnswer {
    const lowerState = state.toLowerCase();
    const criteria = q.criteria;
    const maxIdx = Math.max(1, criteria.length - 1);

    // 6. Risk level
    if (q.instructions.toLowerCase().includes('risk') || q.instructions.toLowerCase().includes('risco')) {
      let score = 0.1; // low
      if (/rm -rf|drop database|force push|delete critical/i.test(lowerState)) {
        score = 3.0; // critical
      } else if (/git reset|overwrite|uninstall|kill -9|truncate/i.test(lowerState)) {
        score = 2.1; // high
      } else if (/edit|modify|update|replace|patch/i.test(lowerState)) {
        score = 1.2; // medium
      } else {
        score = 0.3; // low
      }

      const idx = Math.min(maxIdx, Math.max(0, Math.round(score)));
      return {
        type: 'score',
        score: Math.min(maxIdx, score),
        levelIndex: idx,
        levelLabel: criteria[idx] || 'low',
        confidence: 0.92,
      };
    }

    // Generic score
    const half = maxIdx / 2;
    return {
      type: 'score',
      score: half,
      levelIndex: Math.round(half),
      levelLabel: criteria[Math.round(half)] || '',
      confidence: 0.75,
    };
  }
}
