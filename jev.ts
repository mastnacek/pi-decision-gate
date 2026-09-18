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

  // Příprava popisu stavu
  const stateSummary = [
    `Active model: ${activeModel}`,
    `Requested tool: ${toolName}`,
    `Tool input: ${JSON.stringify(input, null, 2)}`,
  ].join("\n");

  const fallbackAssessment: JevAssessment = {
    riskScore: isDestructivePattern ? 2.0 : 0.2,
    riskCategory: isDestructivePattern ? "destructive" : "safe",
    irreversibleProb: isDestructivePattern ? 0.99 : 0.1,
    offTaskProb: 0.1,
    confidence: isDestructivePattern ? 0.95 : 0.5,
    costUsd: 0,
    costCzk: 0,
    modelUsed: "offline-heuristics",
  };

  if (!state.config.useJev) {
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
    const irreversible = data.answers?.irreversible?.noul ?? (isDestructivePattern ? 0.95 : 0.1);
    const offTask = data.answers?.off_task?.noul ?? 0.1;
    const confidence = data.answers?.risk?.confidence ?? 0.8;

    let category: "safe" | "moderate" | "destructive" = "safe";
    if (rawScore >= 1.4 || irreversible >= 0.7 || isDestructivePattern) {
      category = "destructive";
    } else if (rawScore >= 0.7 || irreversible >= 0.4) {
      category = "moderate";
    }

    return {
      riskScore: isDestructivePattern ? Math.max(rawScore, 1.8) : rawScore,
      riskCategory: category,
      irreversibleProb: isDestructivePattern ? Math.max(irreversible, 0.95) : irreversible,
      offTaskProb: offTask,
      confidence,
      costUsd,
      costCzk,
      modelUsed: data.model ?? state.config.jevModel,
    };
  } catch (err) {
    // V případě výpadku sítě nebo timeoutu použijeme offline heuristiku
    return fallbackAssessment;
  }
}
