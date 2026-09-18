// gate.ts — hlavní logika zachytávání a schvalování rozhodnutí modelu

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtSmallAmount } from "./balance";
import { state } from "./config";
import { assessActionWithJev, matchesDestructivePattern } from "./jev";
import { ANSI_BOLD, ANSI_CYAN, ANSI_DIM, ANSI_GREEN, ANSI_RED, ANSI_RESET, ANSI_YELLOW, paint, updateStatusline } from "./status";
import type { DecisionRecord, JevAssessment } from "./types";

/**
 * Uloží záznam o rozhodnutí do auditního logu (.pi/decision-gate/decisions.jsonl)
 */
function logDecision(record: DecisionRecord, cwd?: string): void {
  if (!state.config.logDecisions || !cwd) return;
  try {
    const logDir = join(cwd, ".pi", "decision-gate");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const logFile = join(logDir, "decisions.jsonl");
    appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // ignorujeme chybu zápisu logu
  }
}

/**
 * Interceptuje tool_call a zprostředkuje schválení uživatelem
 */
export async function handleToolCallGate(
  event: { toolName: string; input: Record<string, any> },
  ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const config = state.config;

  // 1. Kontrola zda je brána aktivní
  if (!config.enabled || config.mode === "off") {
    return undefined;
  }

  // 2. Kontrola výjimek
  if (config.exemptTools.includes(event.toolName) || state.sessionExemptions.has(event.toolName)) {
    return undefined;
  }

  // 3. Zjištění aktivního modelu
  const modelProvider = ctx.model?.provider ?? "unknown-provider";
  const modelId = ctx.model?.id ?? "unknown-model";
  const modelLabel = `${modelProvider}/${modelId}`;
  const thinking = ctx.thinkingLevel ? ` [thinking: ${ctx.thinkingLevel}]` : "";

  // 4. Posouzení akce přes Jev model / offline heuristiku
  const assessment = await assessActionWithJev(event.toolName, event.input, modelLabel, ctx);
  updateStatusline(ctx);

  // 5. Vyhodnocení zda je potřeba schválení podle zvoleného režimu
  let needsApproval = false;
  if (config.mode === "always") {
    needsApproval = true;
  } else if (config.mode === "risky") {
    // Normalizované riziko 0.0 - 1.0 (z Jev škály 0..2)
    const normalizedRisk = assessment.riskScore / 2.0;
    if (normalizedRisk >= config.threshold || assessment.irreversibleProb >= config.threshold) {
      needsApproval = true;
    }
  } else if (config.mode === "destructive") {
    if (assessment.riskCategory === "destructive" || matchesDestructivePattern(event.toolName, event.input)) {
      needsApproval = true;
    }
  }

  // Pokud akce nepotřebuje schválení (bezpečná v daném režimu)
  if (!needsApproval) {
    state.approvedCount += 1;
    logDecision(
      {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
        tool: event.toolName,
        input: event.input,
        verdict: "auto_approved",
        assessment,
      },
      ctx.cwd,
    );
    updateStatusline(ctx);
    return undefined;
  }

  // 6. Sestavení dialogu pro schválení v TUI
  if (!ctx.hasUI) {
    // V headless/print režimu bez UI schválíme nebo zablokujeme dle konfigurace
    state.approvedCount += 1;
    return undefined;
  }

  const preview = JSON.stringify(event.input, null, 2);

  // Popisky hodnocení Jev
  const riskColor = assessment.riskCategory === "destructive" ? ANSI_RED : assessment.riskCategory === "moderate" ? ANSI_YELLOW : ANSI_GREEN;
  const costInfo = assessment.costCzk !== undefined
    ? `${fmtSmallAmount(assessment.costCzk)} Kč`
    : `$${fmtSmallAmount(assessment.costUsd)}`;

  const header = [
    `${ANSI_BOLD}${ANSI_CYAN}🛡️ Rozhodnutí modelu vyžaduje schválení${ANSI_RESET}`,
    `Navrhl model: ${paint(ANSI_GREEN, modelLabel)}${paint(ANSI_DIM, thinking)}`,
    `Nástroj:      ${paint(ANSI_YELLOW, event.toolName)}`,
    `Posouzení Jev: ${paint(riskColor, `Riziko ${assessment.riskScore.toFixed(2)}/2.0 (${assessment.riskCategory})`)} │ Nevratnost: ${Math.round(assessment.irreversibleProb * 100)}% │ Náklad: ${costInfo}`,
    "",
    `${ANSI_BOLD}Navrhované argumenty:${ANSI_RESET}`,
    preview,
    "",
    "Vyberte akci:",
  ].join("\n");

  const options = ["Schválit"];
  if (config.allowEdit) {
    options.push("Upravit argumenty");
  }
  options.push("Odmítnout");
  options.push(`Osvobodit '${event.toolName}' pro toto sezení`);

  const choice = await ctx.ui.select(header, options);

  // Zpracování volby
  if (!choice || choice === "Odmítnout") {
    state.blockedCount += 1;
    logDecision(
      {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
        tool: event.toolName,
        input: event.input,
        verdict: "rejected",
        assessment,
      },
      ctx.cwd,
    );
    updateStatusline(ctx);
    return {
      block: true,
      reason: `Akce nástroje '${event.toolName}' navržená modelem [${modelLabel}] byla zamítnuta uživatelem.`,
    };
  }

  if (choice === `Osvobodit '${event.toolName}' pro toto sezení`) {
    state.sessionExemptions.add(event.toolName);
    state.approvedCount += 1;
    ctx.ui.notify(`Nástroj '${event.toolName}' byl osvobozen od schvalování pro zbytek sezení.`, "info");
    logDecision(
      {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
        tool: event.toolName,
        input: event.input,
        verdict: "approved",
        assessment,
      },
      ctx.cwd,
    );
    updateStatusline(ctx);
    return undefined;
  }

  if (choice === "Upravit argumenty") {
    const editedText = await ctx.ui.editor(`Upravit parametry nástroje ${event.toolName} (JSON):`, preview);
    if (editedText) {
      try {
        const parsed = JSON.parse(editedText);
        // Upravit argumenty in-place
        for (const k of Object.keys(event.input)) {
          delete event.input[k];
        }
        Object.assign(event.input, parsed);

        state.editedCount += 1;
        state.approvedCount += 1;
        ctx.ui.notify(`Parametry nástroje '${event.toolName}' upraveny a schváleny.`, "info");
        logDecision(
          {
            id: Math.random().toString(36).slice(2, 10),
            timestamp: new Date().toISOString(),
            model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
            tool: event.toolName,
            input: parsed,
            verdict: "edited",
            assessment,
          },
          ctx.cwd,
        );
        updateStatusline(ctx);
        return undefined;
      } catch (err) {
        state.blockedCount += 1;
        updateStatusline(ctx);
        return {
          block: true,
          reason: `Úprava parametrů nástroje '${event.toolName}' obsahovala neplatný JSON. Akce zrušena.`,
        };
      }
    } else {
      state.blockedCount += 1;
      updateStatusline(ctx);
      return {
        block: true,
        reason: `Úprava parametrů nástroje '${event.toolName}' byla uživatelem stornována.`,
      };
    }
  }

  // Schváleno
  state.approvedCount += 1;
  logDecision(
    {
      id: Math.random().toString(36).slice(2, 10),
      timestamp: new Date().toISOString(),
      model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
      tool: event.toolName,
      input: event.input,
      verdict: "approved",
      assessment,
    },
    ctx.cwd,
  );
  updateStatusline(ctx);
  return undefined;
}
