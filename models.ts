// models.ts — detekce a přehled modelů z historie sezení a konfigurace Pi agenta

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isHerdrEnvironment } from "./herdr";
import type { HerdrPaneRecommendation, JevAssessment, ModelSuitability, ModelUsageStat, ThinkingRecommendation } from "./types";
import { findCatalogEntry } from "./catalog";
import { state } from "./config";
import { rankModelsWithJev, type JevRankCandidate } from "./jev";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
const MODELS_STORE_FILE = join(homedir(), ".pi", "agent", "models-store.json");

interface ModelCache {
  stats: ModelUsageStat[];
  lastScanned: number;
}

let cachedModels: ModelCache | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minut

export function invalidateModelsCache(): void {
  cachedModels = null;
}

/**
 * Rekurzivně projde složku sezení a najde modely použité za posledních N dní
 */
function scanRecentSessions(days: number = 7): Map<string, { provider: string; id: string; count: number; lastUsed: number }> {
  const result = new Map<string, { provider: string; id: string; count: number; lastUsed: number }>();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  function traverse(dir: string) {
    try {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const st = statSync(fullPath);
            if (st.mtimeMs >= cutoff) {
              const content = readFileSync(fullPath, "utf8");
              const lines = content.split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const data = JSON.parse(line);
                  let p: string | undefined;
                  let m: string | undefined;
                  const ts = data.timestamp ? new Date(data.timestamp).getTime() : st.mtimeMs;

                  if (data.type === "model_change" && data.provider && data.modelId) {
                    p = data.provider;
                    m = data.modelId;
                  } else if (
                    data.type === "message" &&
                    data.message?.role === "assistant" &&
                    data.message?.provider &&
                    data.message?.modelId
                  ) {
                    p = data.message.provider;
                    m = data.message.modelId;
                  }

                  if (p && m) {
                    const key = `${p}/${m}`;
                    const cur = result.get(key);
                    if (cur) {
                      cur.count += 1;
                      cur.lastUsed = Math.max(cur.lastUsed, ts);
                    } else {
                      result.set(key, { provider: p, id: m, count: 1, lastUsed: ts });
                    }
                  }
                } catch {
                  // přeskočit nevalidní řádek JSON
                }
              }
            }
          } catch {
            // ignorovat chybu jednoho souboru
          }
        }
      }
    } catch {
      // ignorovat chybu čtení adresáře
    }
  }

  traverse(SESSIONS_DIR);
  return result;
}

/**
 * Získá modely z konfigurace settings.json a models-store.json
 */
function getConfiguredModels(): Array<{ provider: string; id: string }> {
  const list: Array<{ provider: string; id: string }> = [];

  try {
    if (existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (settings.defaultProvider && settings.defaultModel) {
        list.push({ provider: settings.defaultProvider, id: settings.defaultModel });
      }
    }
  } catch {
    // ignorovat
  }

  try {
    if (existsSync(MODELS_STORE_FILE)) {
      const store = JSON.parse(readFileSync(MODELS_STORE_FILE, "utf8"));
      for (const [provider, info] of Object.entries<any>(store)) {
        if (Array.isArray(info?.models)) {
          for (const m of info.models) {
            const id = typeof m === "string" ? m : m?.id;
            if (id) list.push({ provider, id });
          }
        }
      }
    }
  } catch {
    // ignorovat
  }

  return list;
}

/**
 * Líně načte a agreguje modely z historie i konfigurace
 */
export function getRecentAndConfiguredModels(ctx?: ExtensionContext, days: number = 7): ModelUsageStat[] {
  if (cachedModels && Date.now() - cachedModels.lastScanned < CACHE_TTL_MS) {
    return cachedModels.stats;
  }

  const sessionMap = scanRecentSessions(days);
  const configured = getConfiguredModels();
  const resultMap = new Map<string, ModelUsageStat>();

  // 1. Z historie sezení
  for (const [key, val] of sessionMap.entries()) {
    resultMap.set(key, {
      modelKey: key,
      provider: val.provider,
      id: val.id,
      turns: val.count,
      lastUsed: val.lastUsed,
      source: "session",
    });
  }

  // 2. Z konfigurace
  for (const item of configured) {
    const key = `${item.provider}/${item.id}`;
    if (!resultMap.has(key)) {
      resultMap.set(key, {
        modelKey: key,
        provider: item.provider,
        id: item.id,
        turns: 0,
        lastUsed: 0,
        source: "config",
      });
    }
  }

  // 3. Aktivní model v sezení
  if (ctx?.model) {
    const activeKey = `${ctx.model.provider}/${ctx.model.id}`;
    const existing = resultMap.get(activeKey);
    if (existing) {
      existing.source = "active";
    } else {
      resultMap.set(activeKey, {
        modelKey: activeKey,
        provider: ctx.model.provider,
        id: ctx.model.id,
        turns: 1,
        lastUsed: Date.now(),
        source: "active",
      });
    }
  }

  // Seřadit: aktivní první, pak podle počtu tahů sestupně, pak podle času
  const sorted = Array.from(resultMap.values()).sort((a, b) => {
    if (a.source === "active" && b.source !== "active") return -1;
    if (b.source === "active" && a.source !== "active") return 1;
    if (b.turns !== a.turns) return b.turns - a.turns;
    return b.lastUsed - a.lastUsed;
  });

  cachedModels = {
    stats: sorted,
    lastScanned: Date.now(),
  };

  return sorted;
}

/**
 * Naformátuje přehled modelů do textové tabulky
 */
export function formatModelsReport(stats: ModelUsageStat[], activeModelKey?: string): string {
  if (stats.length === 0) {
    return "Nebyly nalezeny žádné záznamy o modelech za posledních 7 dní.";
  }

  const lines = [
    `# Přehled používaných modelů (posledních 7 dní)`,
    `Zdroj: Historie sezení Pi agenta (~/.pi/agent/sessions) a konfigurace`,
    "",
    "| Model | Poskytovatel | Počet volání | Stav / Zdroj |",
    "|---|---|---|---|",
  ];

  for (const s of stats) {
    const isActive = activeModelKey && activeModelKey === s.modelKey;
    const badge = isActive
      ? "**● AKTIVNÍ NYNÍ**"
      : s.source === "active"
        ? "aktivní"
        : s.source === "session"
          ? "historie sezení"
          : "konfigurace";
    lines.push(`| \`${s.modelKey}\` | ${s.provider} | ${s.turns} | ${badge} |`);
  }

  lines.push("");
  lines.push("Tip: Tyto modely určují, která inteligence v sezení navrhuje akce.");
  return lines.join("\n");
}

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
function buildTaskDescription(toolName: string, input: unknown): string {
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
