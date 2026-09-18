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

/**
 * Najde záznam katalogu pro klíč modelu (např. "google/gemini-3.8-flash").
 * Porovnává id, aliasTarget, a ignoruje "~" prefix i ":free" suffix.
 */
export function findCatalogEntry(modelKey: string): CatalogModel | undefined {
  const k = (modelKey ?? "").trim();
  if (!k) return undefined;
  const norm = k.replace(/^~/, "");
  const base = norm.replace(/:free$/, "");
  return getModelCatalog().find((m) => {
    const candidates = [m.id, m.aliasTarget ?? ""].map((s) =>
      s.replace(/^~/, "").replace(/:free$/, ""),
    );
    return candidates.includes(norm) || candidates.includes(base);
  });
}
