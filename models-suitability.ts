// Extracted from models.ts to keep modules focused.
// models.ts — detekce a přehled modelů z historie sezení a konfigurace Pi agenta

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type JevAssessment,
	type ModelSuitability,
	type ThinkingRecommendation,
} from "./types";
import {
	findCatalogEntry,
} from "./catalog";
import {
	getRecentAndConfiguredModels,
} from "./models-usage";

/**
 * Zjistí, zda se jedná o bezpečný průzkumný bash příkaz (čtení dat)
 */
export function isSafeBashCommand(input: unknown): boolean {
  if (typeof input !== "object" || input === null || !("command" in input)) return false;
  const cmd = String((input as { command?: unknown }).command ?? "").trim();
  return /^(?:ls|git\s+(?:status|diff|log|branch|show|rev-parse)|cat|head|tail|grep|rg|find|pwd|echo|printf|which|where|whereis|type|command\s+-[vV]|env|printenv|uname|hostname|stat|file|date|id|whoami)\b/i.test(cmd);
}

/**
 * Doporučí úroveň uvažování (thinking level) podle fáze a rizikovosti úlohy
 */
export function getThinkingRecommendation(
  toolName: string,
  input: unknown,
  assessment: JevAssessment,
  currentLevel?: string,
): ThinkingRecommendation {
  const isDestructiveOrRisky =
    assessment.riskScore >= 1.0 ||
    assessment.irreversibleProb >= 0.5 ||
    assessment.riskCategory === "destructive";

  const isReadOnly = toolName === "read" || (toolName === "bash" && isSafeBashCommand(input));
  const cur = (currentLevel ?? "medium").toLowerCase();

  if (isDestructiveOrRisky) {
    const canOptimize = cur !== "high" && cur !== "max";
    return {
      recommendedLevel: "high",
      reason: "Kritická nebo nevratná akce. Doporučeno hluboké uvažování (high).",
      canOptimize,
    };
  }

  if (isReadOnly) {
    const canOptimize = cur === "high" || cur === "max" || cur === "medium";
    return {
      recommendedLevel: "low",
      reason: "Informativní průzkum. Úroveň 'low' ušetří ~60-80 % tokenů a času.",
      canOptimize,
    };
  }

  // Běžné kódování / mutace
  const canOptimize = cur === "max";
  return {
    recommendedLevel: "medium",
    reason: "Standardní úprava. Vyvážená rychlost a uvažování.",
    canOptimize,
  };
}

/**
 * Vyhodnotí a seřadí modely podle vhodnosti pro danou akci s lidsky čitelným skóre
 */
export function evaluateModelSuitability(
  toolName: string,
  input: unknown,
  assessment: JevAssessment,
  ctx?: ExtensionContext,
): ModelSuitability[] {
  // Seznam modelů pro přepnutí je omezen na katalog models.json
  // (providery google / z-ai / moonshotai / deepseek). Aktivní model
  // ponecháme vždy, i kdyby nebyl v katalogu.
  const activeKey = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const models = getRecentAndConfiguredModels(ctx).filter(
    (m) => findCatalogEntry(m.modelKey) !== undefined || (activeKey !== undefined && m.modelKey === activeKey),
  );
  const isDestructiveOrRisky =
    assessment.riskScore >= 1.0 ||
    assessment.irreversibleProb >= 0.5 ||
    assessment.riskCategory === "destructive";

  const isReadOnly = toolName === "read" || (toolName === "bash" && isSafeBashCommand(input));

  // Zjištění stavu kontextového okna pro posouzení ztráty cache
  const usage = ctx?.getContextUsage?.();
  const contextTokens = usage?.tokens ?? 0;
  const currentModelKey = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

  return models
    .map((m) => {
      let score = 80;
      let reason = "Osvědčený model";
      let cachePenalty = false;
      let cacheNotice: string | undefined;
      const id = m.id.toLowerCase();

      const isHeavyReasoning = /claude-3[.-]7|claude-3[.-]5-sonnet|o3|o1|r1|gemini-1\.5-pro|gemini-2\.5-pro|gpt-4o\b/.test(id);
      const isFastFlash = /flash|haiku|mini|small|lite/.test(id);
      const cat = findCatalogEntry(m.modelKey);
      const priority = cat?.priority === true;

      if (isDestructiveOrRisky) {
        if (isHeavyReasoning) {
          score = 96;
          reason = "Silné uvažování pro rizikové a nevratné změny";
        } else if (isFastFlash) {
          score = 68;
          reason = "Rychlý model, nižší hloubka analýzy rizik";
        } else {
          score = 82;
          reason = "Dostatečný pro středně náročné operace";
        }
      } else if (isReadOnly) {
        if (isFastFlash) {
          score = 97;
          reason = "Blesková odezva a minimální spotřeba pro čtení";
        } else if (isHeavyReasoning) {
          score = 74;
          reason = "Příliš nákladný pro rutinní zjišťování dat";
        } else {
          score = 88;
          reason = "Spolehlivý pro syntézu výstupu";
        }
      } else {
        if (isHeavyReasoning) {
          score = 94;
          reason = "Vysoká přesnost pro generování a úpravy kódu";
        } else if (isFastFlash) {
          score = 85;
          reason = "Rychlá iterace běžných úprav";
        } else {
          score = 86;
          reason = "Vyvážený poměr kvality a rychlosti";
        }
      }

      // Bonus za časté používání v minulosti (až +4 %)
      if (m.turns > 20) score = Math.min(99, score + 4);
      else if (m.turns > 5) score = Math.min(99, score + 2);

      // Posouzení prompt cache: při velkém kontextu penalizovat přepnutí modelu
      if (contextTokens > 25000 && !isDestructiveOrRisky) {
        if (m.modelKey === currentModelKey) {
          score = Math.min(99, score + 3);
          cacheNotice = "✓ Zachová prompt cache";
        } else {
          score = Math.max(45, score - 12);
          cachePenalty = true;
          cacheNotice = `⚠️ Ztráta cache (~${Math.round(contextTokens / 1000)}k tok.)`;
        }
      }

      return {
        modelKey: m.modelKey,
        provider: m.provider,
        id: m.id,
        score,
        reason: priority ? `${reason} · ✓ CCA` : reason,
        turns: m.turns,
        source: m.source,
        priority,
        cachePenalty,
        cacheNotice,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = a.priority ? 1 : 0;
      const pb = b.priority ? 1 : 0;
      return pb - pa;
    });
}

/**
 * Zjistí, zda je příkaz dlouhotrvající, náročný na sestavení nebo vhodný pro oddělené okno
 */
export function isLongRunningOrAutonomousTask(toolName: string, input: unknown): boolean {
  if (toolName === "bash") {
    const cmd = typeof input === "object" && input !== null && "command" in input
      ? String((input as { command?: unknown }).command ?? "").trim()
      : "";
    return /^(?:npm\s+(?:test|run|build|install)|cargo\s+(?:build|test|check)|pytest|python\s+.*test|docker|docker-compose|make|gradle|mvn|composer)\b/i.test(cmd);
  }
  return false;
}
