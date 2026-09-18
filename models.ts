// models.ts — detekce a přehled modelů z historie sezení a konfigurace Pi agenta

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelUsageStat } from "./types";

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
