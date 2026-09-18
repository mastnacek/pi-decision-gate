// config.ts — správa konfigurace, líné načítání a české popisy parametrů

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ApprovalMode, DecisionGateConfig, DecisionGateState } from "./types";

export const DEFAULT_CONFIG: DecisionGateConfig = {
  enabled: true,
  mode: "always",
  threshold: 0.7,
  useJev: true,
  jevModel: "~typesafe/jev-latest",
  exemptTools: ["read"],
  allowEdit: true,
  logDecisions: true,
};

export const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-decision-gate.json");

export const state: DecisionGateState = {
  config: { ...DEFAULT_CONFIG },
  sessionCostUsd: 0,
  approvedCount: 0,
  blockedCount: 0,
  editedCount: 0,
  sessionExemptions: new Set<string>(),
};

/**
 * Centrální dokumentační slovník pro příkazy a autocompleti v češtině
 * dle standardu z AGENTS.md
 */
export const COMMAND_DOCS: Record<string, string> = {
  on: "zapne bránu rozhodování",
  off: "vypne bránu rozhodování",
  status: "zobrazí podrobný přehled stavu, metrik a spotřeby v Kč",
  mode: "nastaví režim schvalování (always | risky | destructive | off)",
  threshold: "nastaví práh rizika pro Jev model (0.1 až 1.0)",
  jev: "zapne nebo vypne hodnocení rizik přes Jev na OpenRouteru (on | off)",
  exempt: "spravuje osvobozené nástroje (exempt add <tool> | remove <tool> | list)",
  edit: "povolí nebo zakáže interaktivní editaci argumentů (on | off)",
  models: "zobrazí modely používané za poslední týden ze sezení",
  balance: "zobrazí zůstatek na OpenRouteru a kurz ČNB (balance refresh)",
  reset: "obnoví výchozí nastavení brány",
  help: "zobrazí detailní nápovědu a vysvětlení parametrů",
};

/**
 * Líné načtení konfigurace (globální + projektová)
 */
export function loadConfig(cwd?: string): DecisionGateConfig {
  let merged: DecisionGateConfig = { ...DEFAULT_CONFIG };

  // 1. Globální konfigurace uživatele
  try {
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      const raw = readFileSync(GLOBAL_CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw);
      merged = { ...merged, ...parsed };
    }
  } catch {
    // ignorujeme chybu čtení
  }

  // 2. Projektová konfigurace (.pi/pi-decision-gate.json)
  if (cwd) {
    try {
      const projFile = join(cwd, ".pi", "pi-decision-gate.json");
      if (existsSync(projFile)) {
        const raw = readFileSync(projFile, "utf8");
        const parsed = JSON.parse(raw);
        merged = { ...merged, ...parsed };
      }
    } catch {
      // ignorujeme chybu čtení
    }
  }

  state.config = merged;
  return merged;
}

/**
 * Uložení konfigurace
 */
export function saveConfig(cfg: DecisionGateConfig, global: boolean = false, cwd?: string): void {
  state.config = { ...cfg };

  if (global) {
    try {
      mkdirSync(dirname(GLOBAL_CONFIG_FILE), { recursive: true });
      writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
    } catch (err) {
      console.error("[pi-decision-gate] Nepodařilo se uložit globální konfiguraci:", err);
    }
  } else if (cwd) {
    try {
      const projDir = join(cwd, ".pi");
      mkdirSync(projDir, { recursive: true });
      const projFile = join(projDir, "pi-decision-gate.json");
      writeFileSync(projFile, JSON.stringify(cfg, null, 2), "utf8");
    } catch (err) {
      console.error("[pi-decision-gate] Nepodařilo se uložit projektovou konfiguraci:", err);
    }
  }
}
