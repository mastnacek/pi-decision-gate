// Extracted from models.ts to keep modules focused.
// models.ts — detekce a přehled modelů z historie sezení a konfigurace Pi agenta

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type HerdrPaneRecommendation,
	type JevAssessment,
	type ModelSuitability,
} from "./types";
import {
	isHerdrEnvironment,
} from "./herdr";
import {
	findCatalogEntry,
} from "./catalog";
import {
	state,
} from "./config";
import {
	rankModelsWithJev,
	type JevRankCandidate,
} from "./jev";
import {
	evaluateModelSuitability,
	isLongRunningOrAutonomousTask,
} from "./models-suitability";

/**
 * Vyhodnotí, zda model a pravidla doporučují delegovat úlohu do nového Herdr okna
 */
export function getHerdrPaneRecommendation(
  toolName: string,
  input: unknown,
  assessment: JevAssessment,
  ctx?: ExtensionContext,
): HerdrPaneRecommendation {
  const herdrAvailable = isHerdrEnvironment();
  const isLongRunning = isLongRunningOrAutonomousTask(toolName, input);
  const jvWantsPane = Boolean(assessment.shouldOffloadToPane || (assessment.isolatePaneScore !== undefined && assessment.isolatePaneScore >= 2));
  const isDestructive = assessment.riskCategory === "destructive";

  const suitable = herdrAvailable && (jvWantsPane || isLongRunning || (isDestructive && assessment.consequenceScore !== undefined && assessment.consequenceScore >= 2));

  // Zvolit nejvhodnější model pro izolovaný běh
  const candidates = evaluateModelSuitability(toolName, input, assessment, ctx);
  const top = candidates[0];
  const recommendedModel = top ? top.modelKey : (ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "google/gemini-3.8-flash");
  const recommendedEffort = assessment.recommendedEffort ?? (isDestructive ? "high" : isLongRunning ? "medium" : "low");

  let reason = "Triviální sekvenční krok — lépe ponechat v aktuálním okně.";
  if (suitable) {
    if (isDestructive) {
      reason = "Kritická / destruktivní akce. Doporučeno oddělit do izolovaného okna pro bezpečnost.";
    } else if (isLongRunning) {
      reason = "Dlouhotrvající sestavení / test. Běh v novém okně neblokuje hlavní relaci.";
    } else if (jvWantsPane) {
      reason = assessment.offloadReason ?? "Sémanticky samostatný úkol vhodný pro sub-agenta.";
    }
  }

  return {
    suitable,
    reason,
    recommendedModel,
    recommendedEffort,
    agentKind: "pi",
  };
}

/**
 * Sestaví krátký popis úkolu pro Jev ranking.
 */
export function buildTaskDescription(toolName: string, input: unknown): string {
  const serialized =
    typeof input === "object" && input !== null
      ? JSON.stringify(input)
      : String(input ?? "");
  return `Tool: ${toolName}. Input: ${serialized.slice(0, 300)}`;
}

/**
 * Doporučí modely pro danou akci: primárně přes Jev ranking
 * (katalog models.json + benchmarky), s fallbackem na heuristiku při výpadku.
 */
export async function recommendModelsForAction(
  toolName: string,
  input: unknown,
  assessment: JevAssessment,
  ctx?: ExtensionContext,
): Promise<ModelSuitability[]> {
  const heuristic = evaluateModelSuitability(toolName, input, assessment, ctx);
  if (!state.config.useJev) return heuristic;

  const candidates: JevRankCandidate[] = heuristic.slice(0, 12).map((h) => {
    const cat = findCatalogEntry(h.modelKey);
    return {
      id: h.modelKey,
      name: cat?.name ?? h.modelKey,
      description: cat?.description,
      indices: cat?.benchmarks?.artificialAnalysis ?? null,
      codeElo: cat?.benchmarks?.designArena?.codeCategories?.elo ?? null,
      codeWinRate: cat?.benchmarks?.designArena?.codeCategories?.winRate ?? null,
      reasoningEfforts: cat?.reasoning?.supportedEfforts,
      pricing: cat?.pricing,
      contextLength: cat?.contextLength,
      free: cat?.free,
    };
  });

  const task = buildTaskDescription(toolName, input);
  const ranking = await rankModelsWithJev(candidates, task, ctx);
  if (!ranking) return heuristic;

  const scored = heuristic
    .map((h) => {
      const prob = ranking.probabilities[h.modelKey];
      if (typeof prob === "number") {
        return {
          ...h,
          score: Math.max(1, Math.round(prob * 100)),
          reason: `Jev: ${Math.round(prob * 100)} % vhodnost (${h.reason})`,
        };
      }
      return { ...h, score: 0, reason: "Jev model nevyhodnotil" };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = a.priority ? 1 : 0;
      const pb = b.priority ? 1 : 0;
      return pb - pa;
    });

  // Pravidlo konfidence (dle agent-router): při závažném důsledku a nízké
  // konfidenci Jev explicitně zvýrazni top-2 kandidáty.
  const consequence =
    assessment.consequenceScore ?? (assessment.riskCategory === "destructive" ? 3 : 0);
  const lowConfidence = consequence >= 2 && ranking.confidence < 0.75;
  if (lowConfidence && scored.length >= 2) {
    for (const m of scored.slice(0, 2)) {
      m.recommended = true;
    }
  }

  return scored;
}
