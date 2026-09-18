// jev.ts — integrace Jev System One modelu přes OpenRouter Decisions API

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getOpenRouterApiKey, getUsdToCzkRate } from "./balance";
import { state } from "./config";
import type { JevAssessment } from "./types";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

// Heuristické vzory pro destruktivní / nevratné příkazy
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-(?:r|rf|fr)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-(?:f|fd|df)\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\b(?:drop|truncate|delete\s+from)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/[a-z0-9]+/i,
  /\bchmod\s+-R\s+777\b/i,
];

// Vzory citlivých dat (API klíče, tokeny, privátní klíče) dle agent-router security standardu
const SENSITIVE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{20,}|Bearer\s+\S+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\b(?:password|passwd|secret|cookie|authorization)\s*[:=]\s*["']?\S+["']?/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'/:@]+:[^\s"'@]+@[^\s"']+/i,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
];

/**
 * Zkontroluje, zda payload obsahuje citlivé údaje před odesláním na externí API
 */
export function containsSensitiveData(data: unknown): boolean {
  try {
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(serialized));
  } catch {
    return false;
  }
}

/**
 * Zkontroluje, zda akce odpovídá známým destruktivním vzorům
 */
export function matchesDestructivePattern(toolName: string, input: unknown): boolean {
  if (toolName === "bash") {
    const cmd = typeof input === "object" && input !== null && "command" in input
      ? String((input as any).command)
      : "";
    return DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd));
  }
  return false;
}

/**
 * Posoudí plánovanou akci modelu pomocí Jev modelu přes OpenRouter
 */
export async function assessActionWithJev(
  toolName: string,
  input: unknown,
  activeModel: string,
  ctx?: ExtensionContext,
): Promise<JevAssessment> {
  const isDestructivePattern = matchesDestructivePattern(toolName, input);
  const isSensitive = containsSensitiveData(input);

  // Příprava popisu stavu
  const stateSummary = [
    `Active model: ${activeModel}`,
    `Requested tool: ${toolName}`,
    `Tool input: ${JSON.stringify(input, null, 2)}`,
  ].join("\n");

  const fallbackAssessment: JevAssessment = {
    riskScore: isDestructivePattern || isSensitive ? 2.0 : 0.2,
    riskCategory: isDestructivePattern || isSensitive ? "destructive" : "safe",
    irreversibleProb: isDestructivePattern ? 0.99 : isSensitive ? 0.8 : 0.1,
    offTaskProb: 0.1,
    confidence: isDestructivePattern || isSensitive ? 0.95 : 0.5,
    consequenceScore: isDestructivePattern || isSensitive ? 3 : 0,
    taskFamily: isDestructivePattern ? "cleanup" : isSensitive ? "credential-handling" : "routine-transformation",
    recommendedEffort: isDestructivePattern || isSensitive ? "high" : "low",
    isolatePaneScore: isDestructivePattern ? 2 : 0,
    shouldOffloadToPane: isDestructivePattern,
    offloadReason: isDestructivePattern ? "Destruktivní akce vhodná pro izolované okno." : undefined,
    costUsd: 0,
    costCzk: 0,
    modelUsed: "offline-heuristics",
    sanitized: isSensitive,
  };

  if (!state.config.useJev) {
    return fallbackAssessment;
  }

  // Bezpečnostní pojistka: neodesílat payload s privátními klíči/tokeny na externí API
  if (isSensitive) {
    return fallbackAssessment;
  }

  const apiKey = await getOpenRouterApiKey(ctx);
  if (!apiKey) {
    return fallbackAssessment;
  }

  const payload = {
    model: state.config.jevModel || "~typesafe/jev-latest",
    state: stateSummary,
    questions: {
      risk: {
        type: "score",
        instructions: "How risky or dangerous is this proposed tool execution for project files, system integrity, or external resources?",
        criteria: [
          "Safe read-only or harmless diagnostic query",
          "Minor reversible local edit or standard development command",
          "Destructive, irreversible, file deletion, database wipe, or external overwrite",
        ],
      },
      consequence: {
        type: "score",
        instructions: "How severe is the blast radius or consequence if this action is incorrect or unintended?",
        criteria: [
          "Very low: bounded read or safe isolated query",
          "Moderate: localized file modification or build task",
          "High: multi-file alteration or potential service interruption",
          "Severe: system damage, data loss, or irreversible remote push",
        ],
      },
      family: {
        type: "choice",
        instructions: "Which task family best describes this action?",
        criteria: {
          "routine-transformation": "Mechanical, read-only or standard execution",
          "investigation": "Diagnostic search, exploration or inspecting state",
          "mutation": "Code modification, configuration write or refactoring",
          "cleanup": "File deletion, state reset or destructive clean",
        },
      },
      effort: {
        type: "choice",
        instructions: "What reasoning effort is recommended for evaluating and synthesizing this step?",
        criteria: {
          "low": "Trivial data gathering or straightforward query",
          "medium": "Standard code changes or localized testing",
          "high": "Complex architectural modifications or critical operations",
        },
      },
      isolate_pane: {
        type: "score",
        instructions: "How beneficial is it to run this action/task in an isolated sub-pane or separate workspace instead of the main interactive terminal?",
        criteria: [
          "Very low: trivial sequential step, best kept in current session",
          "Moderate: standalone read, query, or standard check",
          "High: long-running task, complex build/test, autonomous spike, or risky modification",
        ],
      },
      irreversible: {
        type: "noul",
        instructions: "Is this action irreversible or destructive to data/state if executed?",
      },
      off_task: {
        type: "noul",
        instructions: "Does this action appear unrelated or clearly deviating from typical coding assistance tasks?",
      },
    },
  };

  try {
    const res = await fetch(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctx?.signal,
    });

    if (!res.ok) {
      return fallbackAssessment;
    }

    const data = (await res.json()) as {
      model?: string;
      answers?: {
        risk?: { score?: number; confidence?: number };
        consequence?: { score?: number; confidence?: number };
        family?: { choice?: string; confidence?: number };
        effort?: { choice?: string; confidence?: number };
        isolate_pane?: { score?: number; confidence?: number };
        irreversible?: { noul?: number };
        off_task?: { noul?: number };
      };
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
      };
    };

    const costUsd = data.usage?.cost ?? (data.usage?.input_tokens ?? 0) * (0.042 / 1_000_000);
    state.sessionCostUsd += costUsd;

    const czkRate = await getUsdToCzkRate(ctx?.signal);
    const costCzk = typeof czkRate === "number" && czkRate > 0 ? costUsd * czkRate : undefined;

    const rawScore = data.answers?.risk?.score ?? (isDestructivePattern ? 2.0 : 0.2);
    const consequence = data.answers?.consequence?.score ?? (isDestructivePattern ? 3 : 0);
    const irreversible = data.answers?.irreversible?.noul ?? (isDestructivePattern ? 0.95 : 0.1);
    const offTask = data.answers?.off_task?.noul ?? 0.1;
    const confidence = data.answers?.risk?.confidence ?? 0.8;
    const taskFamily = data.answers?.family?.choice ?? (isDestructivePattern ? "cleanup" : "routine-transformation");
    const recommendedEffort = (data.answers?.effort?.choice as "low" | "medium" | "high") ?? (isDestructivePattern ? "high" : "medium");
    const isolateScore = data.answers?.isolate_pane?.score ?? (isDestructivePattern ? 2 : 0);
    const shouldOffload = isolateScore >= 2 || (taskFamily === "investigation" && consequence >= 2);
    const offloadReason = shouldOffload
      ? "Autonomní nebo náročný úkol vhodný pro izolovaný běh v novém okně."
      : undefined;

    let category: "safe" | "moderate" | "destructive" = "safe";
    if (rawScore >= 1.4 || consequence >= 2 || irreversible >= 0.7 || isDestructivePattern) {
      category = "destructive";
    } else if (rawScore >= 0.7 || consequence >= 1 || irreversible >= 0.4) {
      category = "moderate";
    }

    return {
      riskScore: isDestructivePattern ? Math.max(rawScore, 1.8) : rawScore,
      riskCategory: category,
      irreversibleProb: isDestructivePattern ? Math.max(irreversible, 0.95) : irreversible,
      offTaskProb: offTask,
      confidence,
      consequenceScore: consequence,
      taskFamily,
      recommendedEffort,
      isolatePaneScore: isolateScore,
      shouldOffloadToPane: shouldOffload,
      offloadReason,
      costUsd,
      costCzk,
      modelUsed: data.model ?? state.config.jevModel,
    };
  } catch {
    // V případě výpadku sítě nebo timeoutu použijeme offline heuristiku
    return fallbackAssessment;
  }
}
