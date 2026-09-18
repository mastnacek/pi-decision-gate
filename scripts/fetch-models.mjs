#!/usr/bin/env node
// fetch-models.mjs — refresh models.json from the OpenRouter catalog.
// Providers: google, z-ai, moonshotai, deepseek, qwen.
// Captures: ~...-latest router slugs + :free variants, plus explicit rolling
// slugs pro google CCA a Qwen (které "-latest" aliasy nemají).
// Usage:  node scripts/fetch-models.mjs [--out <path>]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://openrouter.ai/api/v1/models";
const PROVIDERS = ["google", "z-ai", "moonshotai", "deepseek", "qwen"];
const DEFAULT_OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "models.json");

// Modely z pi-google-cca (Google Cloud Code Assist OAuth) — uživatel je má
// v předplatném, takže mají v seznamu přepínání modelů přednost.
// Jedná se o pi google catalog id, které CCA směruje (ANTIGRAVITY_MODEL_ROUTING
// + thinking token budgets pro rodinu 2.5).
const GOOGLE_CCA_MODEL_IDS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

function providerOf(id) {
  return id.replace(/^~/, "").split("/")[0];
}

/** Přesná shoda: "google/gemini-3.8-flash" -> true, "google/gemini-3.8-flash:batch" -> false. */
function isGoogleCcaModel(id) {
  const withoutTilde = id.replace(/^~/, "");
  if (!withoutTilde.startsWith("google/")) return false;
  return GOOGLE_CCA_MODEL_IDS.includes(withoutTilde.slice("google/".length));
}

// Aktuální Qwen modely. Qwen na OpenRouteru nepoužívá "-latest" aliasy
// (na rozdíl od google/deepseek/z-ai/moonshotai) — aktuální generace jsou
// stabilní "rolling" slugy + datované snapshoty vlajkových modelů.
const QWEN_MODEL_IDS = [
  "qwen3-coder",
  "qwen3-coder-plus",
  "qwen3-coder-flash",
  "qwen3-max",
  "qwen3-max-thinking",
  "qwen3.7-flash",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.8-flash",
  "qwen3.8-27b",
  "qwen3.8-2.4t-a95b",
  "qwen3.8-max-0902",
];

/** Přesná shoda: "qwen/qwen3.8-flash" -> true, "qwen/qwen3.8-flash:batch" -> false. */
function isQwenCurrentModel(id) {
  const withoutTilde = id.replace(/^~/, "");
  if (!withoutTilde.startsWith("qwen/")) return false;
  return QWEN_MODEL_IDS.includes(withoutTilde.slice("qwen/".length));
}

function summarizeDesignArena(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let top = entries[0];
  for (const e of entries) {
    if ((e.elo ?? -1) > (top.elo ?? -1)) top = e;
  }
  const code = entries.find((e) => e.category === "codecategories");
  return {
    entries: entries.length,
    topElo: top.elo ?? null,
    topArena: top.arena ?? null,
    topCategory: top.category ?? null,
    topWinRate: top.win_rate ?? null,
    codeCategories: code
      ? { elo: code.elo ?? null, winRate: code.win_rate ?? null }
      : null,
  };
}

function benchmarkInfo(m) {
  const aa = m.benchmarks?.artificial_analysis;
  const da = m.benchmarks?.design_arena;
  return {
    artificialAnalysis: aa
      ? {
          intelligence: aa.intelligence_index ?? null,
          coding: aa.coding_index ?? null,
          agentic: aa.agentic_index ?? null,
        }
      : null,
    designArena: summarizeDesignArena(da),
  };
}

/**
 * Build one catalog entry. For `~...-latest` aliases the descriptive data
 * (name, description, reasoning, benchmarks, context) is resolved from the
 * concrete target model named by alias_target.slug.
 */
function build(id, m, byId) {
  const free = id.includes(":free");
  const targetSlug = m.alias_target?.slug;
  const src = targetSlug ? byId.get(targetSlug) ?? m : m;
  const reasoning = src.reasoning ?? {};
  return {
    id,
    provider: providerOf(id),
    kind: free ? "free" : "latest",
    priority: isGoogleCcaModel(id),
    aliasTarget: targetSlug ?? null,
    free,
    name: src.name ?? null,
    description: src.description ?? null,
    contextLength: src.context_length ?? null,
    inputModalities: src.architecture?.input_modalities ?? [],
    knowledgeCutoff: src.knowledge_cutoff ?? null,
    pricing: {
      prompt: Number(src.pricing?.prompt ?? 0),
      completion: Number(src.pricing?.completion ?? 0),
    },
    reasoning: {
      mandatory: reasoning.mandatory ?? null,
      defaultEnabled: reasoning.default_enabled ?? null,
      supportedEfforts: reasoning.supported_efforts ?? [],
      defaultEffort: reasoning.default_effort ?? null,
    },
    benchmarks: benchmarkInfo(src),
  };
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx !== -1 ? process.argv[outIdx + 1] : DEFAULT_OUT;

  const res = await fetch(API_URL);
  if (!res.ok) {
    console.error(`fetch-models: OpenRouter API returned ${res.status}`);
    process.exit(1);
  }
  const payload = await res.json();
  const all = payload.data ?? [];
  const byId = new Map(all.map((m) => [m.id, m]));

  const selected = all.filter((m) => {
    const p = providerOf(m.id);
    if (!PROVIDERS.includes(p)) return false;
    // Google CCA a Qwen rolling slugy nemají "-latest" aliasy → výslovný seznam.
    if (isGoogleCcaModel(m.id) || isQwenCurrentModel(m.id)) return true;
    return m.id.includes(":free") || /-latest$/.test(m.id);
  });

  const models = selected.map((m) => build(m.id, m, byId));
  // Modely z pi-google-cca (v předplatném) mají přednost — řadíme je první.
  models.sort((a, b) => {
    const pa = a.priority ? 1 : 0;
    const pb = b.priority ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return a.id.localeCompare(b.id);
  });
  const doc = {
    generatedAt: new Date().toISOString(),
    source: API_URL,
    providers: PROVIDERS,
    models,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`fetch-models: wrote ${models.length} models to ${out}`);
}

main().catch((err) => {
  console.error("fetch-models:", err?.message ?? err);
  process.exit(1);
});
