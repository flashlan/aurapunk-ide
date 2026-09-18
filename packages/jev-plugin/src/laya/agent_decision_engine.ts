import type { DecisionClassifier } from '../classifiers/interface.js';
import { LayaClassifier } from '../classifiers/laya_classifier.js';
import type {
  AgentStepAssessment,
  ChoiceQuestion,
  ChoiceResult,
  NoulQuestion,
  NoulResult,
  RiskLevel,
  ScoreQuestion,
  ScoreResult,
  TypedQuestion,
} from '../types.js';

export interface AgentStepInput {
  userRequest: string;
  context?: string;
  availableTools?: Record<string, string>;
  availableAgents?: Record<string, string>;
  proposedCall?: {
    tool: string;
    input: any;
  };
}

export const DEFAULT_TOOLS: Record<string, string> = {
  view_file: 'Read files or inspect directories from the codebase',
  edit_file: 'Modify, edit, or write code into files',
  run_command: 'Execute terminal/shell commands, tests, or builds',
  grep_search: 'Search pattern or symbols in the codebase',
  ask_question: 'Ask user clarification or confirmation',
};

export const DEFAULT_AGENTS: Record<string, string> = {
  executor: 'Direct code implementation, editing, and execution',
  planner: 'System architecture, multi-step planning, and specifications',
  reviewer: 'Code review, test verification, and quality gating',
  pm: 'Requirements intake, user interaction, and high-level backlog',
};

export class AgentDecisionEngine {
  private classifier: DecisionClassifier;

  constructor(classifier?: DecisionClassifier) {
    this.classifier = classifier || new LayaClassifier();
  }

  /**
   * Evaluates all 9 autonomous decisions in a single forward pass / batch:
   * 1. se alguma ferramenta é necessária;
   * 2. qual ferramenta usar;
   * 3. se deve responder diretamente;
   * 4. se faltam informações;
   * 5. se precisa pedir confirmação;
   * 6. o nível de risco da operação;
   * 7. se deve escalar para um modelo maior;
   * 8. se a chamada proposta combina com o pedido;
   * 9. qual agente deve receber a tarefa.
   */
  async evaluateStep(input: AgentStepInput): Promise<AgentStepAssessment> {
    const startTime = Date.now();
    const tools = input.availableTools || DEFAULT_TOOLS;
    const agents = input.availableAgents || DEFAULT_AGENTS;

    // Compose concise state for Laya
    let state = `USER_REQUEST: ${input.userRequest}\n`;
    if (input.context) {
      state += `CONTEXT: ${input.context}\n`;
    }
    if (input.proposedCall) {
      const callStr = JSON.stringify(input.proposedCall.input);
      state += `PROPOSED_CALL: Tool: ${input.proposedCall.tool} input: ${callStr}\n`;
    }

    // Build the 9 typed questions
    const questions: Record<string, TypedQuestion> = {
      // 1. se alguma ferramenta é necessária (noul)
      needs_tool: {
        type: 'noul',
        instructions:
          'Is an external tool or filesystem/shell action needed to fulfill this request?',
      } as NoulQuestion,

      // 2. qual ferramenta usar (choice)
      tool_choice: {
        type: 'choice',
        instructions: 'Which tool should be invoked to handle this user request?',
        criteria: tools,
      } as ChoiceQuestion,

      // 3. se deve responder diretamente (noul)
      respond_directly: {
        type: 'noul',
        instructions:
          'Can the assistant respond directly with conversational text without calling any tools?',
      } as NoulQuestion,

      // 4. se faltam informações (noul)
      missing_info: {
        type: 'noul',
        instructions:
          'Are critical details, parameters, or specifications missing from the request?',
      } as NoulQuestion,

      // 5. se precisa pedir confirmação (noul)
      needs_confirmation: {
        type: 'noul',
        instructions:
          'Does this operation carry high risk or destructive consequences requiring user confirmation?',
      } as NoulQuestion,

      // 6. o nível de risco da operação (score)
      risk_level: {
        type: 'score',
        instructions: 'What is the operational risk level of the proposed action?',
        criteria: [
          'low (read-only query or safe check)',
          'medium (local code change or test execution)',
          'high (destructive edit, dependency install, git reset)',
          'critical (data wipe, force push, system service modification)',
        ],
      } as ScoreQuestion,

      // 7. se deve escalar para um modelo maior (noul)
      escalate_model: {
        type: 'noul',
        instructions:
          'Is the task too complex for a fast System-1 model, requiring escalation to a larger frontier LLM?',
      } as NoulQuestion,

      // 8. se a chamada proposta combina com o pedido (noul)
      call_matches: {
        type: 'noul',
        instructions:
          'Does the proposed tool call match the user intent and requested operation?',
      } as NoulQuestion,

      // 9. qual agente deve receber a tarefa (choice)
      agent_routing: {
        type: 'choice',
        instructions: 'Which specialized agent should receive this task?',
        criteria: agents,
      } as ChoiceQuestion,
    };

    const evalResult = await this.classifier.evaluateQuestions(state, questions);
    const answers = evalResult.answers;

    // 1. Needs tool
    const needsToolAnswer = answers.needs_tool as NoulResult;
    // 2. Tool choice
    const toolChoiceAnswer = answers.tool_choice as ChoiceResult;
    // 3. Respond directly
    const respondDirectlyAnswer = answers.respond_directly as NoulResult;
    // 4. Missing info
    const missingInfoAnswer = answers.missing_info as NoulResult;
    // 5. Needs confirmation
    const needsConfAnswer = answers.needs_confirmation as NoulResult;
    // 6. Risk level
    const riskAnswer = answers.risk_level as ScoreResult;
    const riskIndexToLevel: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const riskLevel: RiskLevel =
      riskIndexToLevel[riskAnswer?.levelIndex ?? 0] || 'low';
    // 7. Escalate model
    const escalateAnswer = answers.escalate_model as NoulResult;
    // 8. Call matches
    const callMatchesAnswer = answers.call_matches as NoulResult;
    // 9. Agent routing
    const agentRoutingAnswer = answers.agent_routing as ChoiceResult;

    return {
      needsTool: {
        needed: needsToolAnswer?.verdict ?? true,
        confidence: needsToolAnswer?.probability ?? 0.85,
      },
      toolChoice: {
        tool: toolChoiceAnswer?.choice ?? Object.keys(tools)[0],
        confidence: toolChoiceAnswer?.confidence ?? 0.85,
        optionsEvaluated: Object.keys(tools),
      },
      respondDirectly: {
        direct: respondDirectlyAnswer?.verdict ?? false,
        confidence: respondDirectlyAnswer?.probability ?? 0.15,
      },
      missingInformation: {
        hasMissingInfo: missingInfoAnswer?.verdict ?? false,
        confidence: missingInfoAnswer?.probability ?? 0.18,
      },
      needsConfirmation: {
        required: needsConfAnswer?.verdict ?? false,
        confidence: needsConfAnswer?.probability ?? 0.12,
        reason: needsConfAnswer?.verdict
          ? 'Potentially destructive or high-impact operation detected'
          : undefined,
      },
      riskLevel: {
        level: riskLevel,
        score: riskAnswer?.score ?? 0.2,
        confidence: riskAnswer?.confidence ?? 0.9,
      },
      escalateToLargerModel: {
        escalate: escalateAnswer?.verdict ?? false,
        confidence: escalateAnswer?.probability ?? 0.2,
        reason: escalateAnswer?.verdict
          ? 'Complex multi-step or architectural reasoning required'
          : undefined,
      },
      callMatchesRequest: {
        matches: callMatchesAnswer?.verdict ?? true,
        confidence: callMatchesAnswer?.probability ?? 0.9,
      },
      agentRouting: {
        agent: agentRoutingAnswer?.choice ?? Object.keys(agents)[0],
        confidence: agentRoutingAnswer?.confidence ?? 0.85,
        candidates: Object.keys(agents),
      },
      evaluatedAt: new Date().toISOString(),
      provider: this.classifier.providerName,
      latencyMs: Date.now() - startTime,
    };
  }
}
