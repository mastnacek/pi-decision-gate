// catalog.ts — načtení katalogu modelů (models.json) generovaného fetch-models.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CatalogBenchmarks {
  artificialAnalysis: {
    intelligence: number | null;
    coding: number | null;
    agentic: number | null;
  } | null;
  designArena: {
    entries: number;
    topElo: number | null;
    topArena: string | null;
    topCategory: string | null;
    topWinRate: number | null;
    codeCategories: { elo: number | null; winRate: number | null } | null;
  } | null;
}

export interface CatalogModel {
  id: string;
  provider: string;
  kind: "latest" | "free";
  aliasTarget: string | null;
  free: boolean;
  /** True = model z pi-google-cca (v předplatném) — má přednost v seznamu. */
  priority?: boolean;
  name: string | null;
  description: string | null;
  contextLength: number | null;
  inputModalities: string[];
  knowledgeCutoff: string | null;
  pricing: { prompt: number; completion: number };
  reasoning: {
    mandatory: boolean | null;
    defaultEnabled: boolean | null;
    supportedEfforts: string[];
    defaultEffort: string | null;
  };
  benchmarks: CatalogBenchmarks;
}

const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "models.json");

let cache: CatalogModel[] | null = null;

export function getModelCatalog(): CatalogModel[] {
  if (cache) return cache;
  try {
    if (existsSync(CATALOG_PATH)) {
      const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
      const models: CatalogModel[] = Array.isArray(raw?.models) ? raw.models : [];
      cache = models;
      return models;
    }
  } catch {
    // ignorujeme chybu čtení katalogu
  }
  cache = [];
  return cache;
}

export function invalidateModelCatalog(): void {
  cache = null;
}

/** Normalizace klíče modelu: strip "~" prefix a ":free" suffix. */
function normalizeModelKey(s: string): string {
  return s.replace(/^~/, "").replace(/:free$/, "");
}

/** Aliasy providerů: klíč v models-store vs provider v katalogu models.json. */
const PROVIDER_ALIASES: Record<string, string> = {
  "zai-coding-cn": "z-ai",
  "zai-coding": "z-ai",
};

/** Vytvoří normalizované varianty klíče pro porovnání s katalogem. */
function modelKeyVariants(modelKey: string): string[] {
  const k = modelKey.trim();
  if (!k) return [];

  const variants = new Set<string>();
  variants.add(normalizeModelKey(k));

  // Oříznutí router prefixu (models-store vede model pod "openrouter/")
  if (k.startsWith("openrouter/")) {
    variants.add(normalizeModelKey(k.slice("openrouter/".length)));
  }

  // Alias provideru v první části klíče (např. zai-coding-cn -> z-ai)
  const slash = k.indexOf("/");
  if (slash > 0) {
    const mapped = PROVIDER_ALIASES[k.slice(0, slash)];
    if (mapped) {
      variants.add(normalizeModelKey(`${mapped}/${k.slice(slash + 1)}`));
    }
  }

  return Array.from(variants);
}

/**
 * Najde záznam katalogu pro klíč modelu (např. "google/gemini-3.8-flash").
 * Porovnává id i aliasTarget, ignoruje "~" prefix a ":free" suffix,
 * ořezává "openrouter/" prefix a mapuje aliasy providerů.
 */
export function findCatalogEntry(modelKey: string): CatalogModel | undefined {
  const variants = modelKeyVariants(modelKey);
  if (variants.length === 0) return undefined;

  for (const m of getModelCatalog()) {
    const candidates = [m.id, m.aliasTarget ?? ""].map(normalizeModelKey);
    if (candidates.some((c) => c && variants.includes(c))) {
      return m;
    }
  }
  return undefined;
}
