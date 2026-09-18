// gate.ts — hlavní logika zachytávání a schvalování rozhodnutí modelu

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtSmallAmount } from "./balance";
import { state } from "./config";
import { assessActionWithJev, matchesDestructivePattern } from "./jev";
import { evaluateModelSuitability, getHerdrPaneRecommendation, getThinkingRecommendation, recommendModelsForAction } from "./models";
import { isHerdrEnvironment, promptHerdrAgent, splitHerdrPane, startHerdrAgent } from "./herdr";
import {
  ANSI_BOLD,
  ANSI_RESET,
  ELDRITCH_CYAN,
  ELDRITCH_DIM,
  ELDRITCH_GRAY,
  ELDRITCH_GREEN,
  ELDRITCH_ORANGE,
  ELDRITCH_PURPLE,
  ELDRITCH_PURPLE_LIGHT,
  ELDRITCH_RED,
  ELDRITCH_TEXT,
  ELDRITCH_YELLOW,
  highlightJsonEldritch,
  paint,
  updateStatusline,
} from "./status";
import type { DecisionRecord, ModelSuitability, ThinkingRecommendation } from "./types";

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
 * Sestaví jednořádkový verdikt o myšlení a modelu pro hlavičku dialogu.
 */
function buildDecisionVerdictLine(
  ctx: ExtensionContext,
  thinkingRec: ThinkingRecommendation,
  currentCandidate: ModelSuitability | undefined,
): string {
  const currentThinking = (ctx.thinkingLevel ?? "medium").toLowerCase();

  const thinkingSeg = thinkingRec.canOptimize
    ? `${currentThinking} → ${thinkingRec.recommendedLevel}`
    : `${currentThinking} ✓`;

  const reasons: string[] = [];
  if (thinkingRec.canOptimize) {
    reasons.push(thinkingRec.reason);
  }
  if (currentCandidate?.cacheNotice?.startsWith("✓")) {
    reasons.push("přepnutí modelu by ztratilo prompt cache");
  }

  const reasonText =
    reasons.length > 0 ? reasons.join("; ") : "aktuální nastavení vyhovuje";

  return [
    paint(ELDRITCH_PURPLE, "🧠"),
    paint(ELDRITCH_TEXT, thinkingSeg),
    paint(ELDRITCH_DIM, "·"),
    paint(ELDRITCH_CYAN, "🤖"),
    paint(ELDRITCH_TEXT, "keep model"),
    paint(ELDRITCH_DIM, "—"),
    paint(ELDRITCH_GRAY, reasonText),
  ].join(" ");
}

/**
 * Interceptuje tool_call a zprostředkuje schválení uživatelem
 */
export async function handleToolCallGate(
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
  pi?: ExtensionAPI,
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

  const rawPreview = JSON.stringify(event.input, null, 2);
  const preview = highlightJsonEldritch(rawPreview);

  // Popisky hodnocení Jev v barvách Eldritch
  const riskColor = assessment.riskCategory === "destructive"
    ? `${ANSI_BOLD}${ELDRITCH_RED}`
    : assessment.riskCategory === "moderate"
      ? ELDRITCH_YELLOW
      : ELDRITCH_GREEN;

  const costInfo = assessment.costCzk !== undefined
    ? `${fmtSmallAmount(assessment.costCzk)} Kč`
    : `$${fmtSmallAmount(assessment.costUsd)}`;

  const thinkingRec = getThinkingRecommendation(event.toolName, event.input, assessment, ctx.thinkingLevel);
  const herdrRec = getHerdrPaneRecommendation(event.toolName, event.input, assessment, ctx);

  const hints: string[] = [];
  if (herdrRec.suitable) {
    hints.push(`${paint(ELDRITCH_CYAN, "🪟 Herdr:")} ${paint(ELDRITCH_TEXT, herdrRec.reason)}`);
  }

  // Jednořádkový verdikt o myšlení a modelu (nad "Vyberte akci")
  const suitability = evaluateModelSuitability(event.toolName, event.input, assessment, ctx);
  const currentCandidate = suitability.find((c) => c.modelKey === modelLabel);
  const verdictLine = buildDecisionVerdictLine(ctx, thinkingRec, currentCandidate);

  const header = [
    `${ANSI_BOLD}${ELDRITCH_PURPLE_LIGHT}🛡️  Rozhodnutí modelu vyžaduje schválení${ANSI_RESET}`,
    paint(ELDRITCH_DIM, "─".repeat(54)),
    `${paint(ELDRITCH_GRAY, "Navrhl model:  ")}${paint(ELDRITCH_PURPLE, modelLabel)}${paint(ELDRITCH_DIM, thinking)}`,
    `${paint(ELDRITCH_GRAY, "Nástroj:       ")}${paint(ANSI_BOLD + ELDRITCH_CYAN, event.toolName)}`,
    `${paint(ELDRITCH_GRAY, "Posouzení Jev: ")}${paint(riskColor, `Riziko ${assessment.riskScore.toFixed(2)}/2.0 (${assessment.riskCategory})`)}${paint(ELDRITCH_DIM, " │ ")}${paint(ELDRITCH_GRAY, "Nevratnost: ")}${paint(ELDRITCH_TEXT, `${Math.round(assessment.irreversibleProb * 100)}%`)}${paint(ELDRITCH_DIM, " │ ")}${paint(ELDRITCH_GRAY, "Náklad: ")}${paint(ELDRITCH_ORANGE, costInfo)}`,
    ...hints,
    "",
    `${ANSI_BOLD}${ELDRITCH_PURPLE}Navrhované argumenty:${ANSI_RESET}`,
    preview,
    "",
    verdictLine,
    paint(ELDRITCH_PURPLE_LIGHT, "Vyberte akci:"),
  ].join("\n");

  const options = ["Schválit"];

  const quickThinkingOption = `Schválit + thinking [${thinkingRec.recommendedLevel}]`;
  if (pi && thinkingRec.canOptimize) {
    options.push(quickThinkingOption);
  }

  let herdrPaneOption: string | undefined;
  if (isHerdrEnvironment()) {
    if (herdrRec.suitable) {
      herdrPaneOption = `🪟 Spustit v novém okně [doporučeno: ${herdrRec.recommendedModel} · ${herdrRec.recommendedEffort}]`;
    } else {
      herdrPaneOption = "🪟 Spustit v novém okně (Herdr pane)";
    }
  }

  if (herdrPaneOption) {
    options.push(herdrPaneOption);
  }

  const switchModelOption = "Přepnout model a zopakovat tah";
  if (pi) {
    options.push(switchModelOption);
  }

  const changeThinkingOption = "Změnit úroveň myšlení (thinking)";
  if (pi) {
    options.push(changeThinkingOption);
  }

  if (config.allowEdit) {
    options.push("Upravit argumenty");
  }
  options.push("Odmítnout");
  options.push(`Osvobodit '${event.toolName}' pro toto sezení`);

  const choice = await ctx.ui.select(header, options);

  // Zpracování rychlých akcí
  if (choice === quickThinkingOption) {
    if (pi) {
      pi.setThinkingLevel(thinkingRec.recommendedLevel);
      ctx.ui.notify(`Úroveň thinking nastavena na [${thinkingRec.recommendedLevel}] pro další uvažování.`, "info");
    }
    state.approvedCount += 1;
    logDecision(
      {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        model: { provider: modelProvider, id: modelId, thinking: thinkingRec.recommendedLevel },
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

  if (herdrPaneOption && choice === herdrPaneOption) {
    const rawCommand =
      event.toolName === "bash" && typeof event.input === "object" && event.input !== null && "command" in event.input
        ? String((event.input as { command?: unknown }).command ?? "")
        : undefined;

    const taskPrompt = rawCommand
      ? `Execute and verify command: ${rawCommand}`
      : `Execute tool '${event.toolName}' with arguments:\n${rawPreview}`;

    ctx.ui.notify("Rozděluji okno v Herdr...", "info");
    const split = await splitHerdrPane({ direction: "right", cwd: ctx.cwd });
    if (!split.ok || !split.paneId) {
      ctx.ui.notify(`Rozdělení okna selhalo: ${split.error ?? "neznámá chyba"}`, "error");
      return handleToolCallGate(event, ctx, pi);
    }

    const paneId = split.paneId;
    const agentName = `sub-${Math.random().toString(36).slice(2, 7)}`;
    ctx.ui.notify(`Vytvořen pane [${paneId}]. Spouštím sub-agenta (${herdrRec.recommendedModel})...`, "info");

    const started = await startHerdrAgent({
      name: agentName,
      kind: herdrRec.agentKind,
      paneId,
      model: herdrRec.recommendedModel,
      thinking: herdrRec.recommendedEffort,
      theme: "eldritch",
    });

    if (!started.ok) {
      ctx.ui.notify(`Spuštění agenta v pane [${paneId}] selhalo: ${started.error}`, "error");
      return handleToolCallGate(event, ctx, pi);
    }

    // Odeslat prompt do nového agenta (asynchronně, aby neblokoval hlavní session)
    void promptHerdrAgent({
      target: agentName,
      promptText: taskPrompt,
      wait: false,
    });

    ctx.ui.notify(`Sub-agent [${agentName}] spuštěn v okně [${paneId}]. Hlavní relace pokračuje.`, "info");

    state.approvedCount += 1;
    logDecision(
      {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        model: { provider: modelProvider, id: modelId, thinking: ctx.thinkingLevel },
        tool: event.toolName,
        input: event.input,
        verdict: "delegated_to_pane",
        assessment,
      },
      ctx.cwd,
    );
    updateStatusline(ctx);

    return {
      block: true,
      reason: `Akce byla delegována do samostatného okna Herdr (pane: ${paneId}, agent: ${agentName}, model: ${herdrRec.recommendedModel}). Původní lokální volání nástroje bylo zrušeno.`,
    };
  }

  if (choice === switchModelOption) {
    const candidates = await recommendModelsForAction(event.toolName, event.input, assessment, ctx);
    const topCandidates = candidates.slice(0, 8);

    const hasLowConfidence = topCandidates.some((c) => c.recommended);
    const modelHeader = [
      `${ANSI_BOLD}${ELDRITCH_PURPLE_LIGHT}🔄  Výběr modelu pro pokračování (dle Jev hodnocení & četnosti)${ANSI_RESET}`,
      paint(ELDRITCH_DIM, "─".repeat(58)),
      paint(ELDRITCH_GRAY, "Zvolte model, který převezme tento tah:"),
      ...(hasLowConfidence
        ? [paint(ELDRITCH_YELLOW, "⚠️  Nízká konfidence Jev — doporučené modely označeny ★")]
        : []),
    ].join("\n");

    const modelOptions = topCandidates.map((c) => {
      const isCurrent = c.modelKey === `${modelProvider}/${modelId}`;
      const prefix = c.recommended ? "★ " : isCurrent ? "● " : "  ";
      const cacheBadge = c.cacheNotice ? ` (${c.cacheNotice})` : "";
      return `${prefix}${c.modelKey} │ ${c.score}% — ${c.reason}${cacheBadge}`;
    });
    modelOptions.push("← Zpět do schvalování");

    const chosenOption = await ctx.ui.select(modelHeader, modelOptions);
    if (!chosenOption || chosenOption === "← Zpět do schvalování") {
      return handleToolCallGate(event, ctx, pi);
    }

    const idx = modelOptions.indexOf(chosenOption);
    const chosenCandidate = topCandidates[idx];
    if (chosenCandidate && pi) {
      let targetModel: any;
      const ctxAny = ctx as any;
      if (ctxAny.modelRegistry) {
        targetModel = ctxAny.modelRegistry.find(chosenCandidate.provider, chosenCandidate.id);
      }
      if (!targetModel && Array.isArray(ctxAny.scopedModels)) {
        const found = ctxAny.scopedModels.find(
          (s: any) => s.model?.provider === chosenCandidate.provider && s.model?.id === chosenCandidate.id,
        );
        targetModel = found?.model;
      }

      if (targetModel) {
        const ok = await pi.setModel(targetModel);
        if (ok) {
          ctx.ui.notify(`Model úspěšně přepnut na [${chosenCandidate.modelKey}]. Opakuji tah.`, "info");
          updateStatusline(ctx);
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
          return {
            block: true,
            reason: `Uživatel změnil model na [${chosenCandidate.modelKey}]. Původní volání nástroje '${event.toolName}' bylo zrušeno a nový model navrhne pokračování.`,
          };
        }
      }

      ctx.ui.notify(`Nepodařilo se aktivovat model [${chosenCandidate.modelKey}]. Ověřte přihlášení (/login).`, "warning");
      return handleToolCallGate(event, ctx, pi);
    }
  }

  if (choice === changeThinkingOption) {
    const thinkingHeader = [
      `${ANSI_BOLD}${ELDRITCH_PURPLE_LIGHT}🧠  Nastavení hloubky uvažování (Thinking Level)${ANSI_RESET}`,
      paint(ELDRITCH_DIM, "─".repeat(50)),
      paint(ELDRITCH_GRAY, `Aktuální úroveň: ${ctx.thinkingLevel ?? "neuvedeno"}`),
      paint(ELDRITCH_DIM, "Vyšší uvažování = vyšší kvalita, ale delší odezva a více tokenů."),
    ].join("\n");

    const levels: Array<{ id: "off" | "minimal" | "low" | "medium" | "high" | "max"; desc: string }> = [
      { id: "off", desc: "Vypnuto (nejrychlejší, bez uvažování)" },
      { id: "minimal", desc: "Minimální (velmi stručné uvažování)" },
      { id: "low", desc: "Nízké (úsporné pro jednoduché úkoly a čtení)" },
      { id: "medium", desc: "Střední (vyvážené pro běžný kód)" },
      { id: "high", desc: "Vysoké (hluboké uvažování pro refaktoring a ladění)" },
      { id: "max", desc: "Maximální (plná analytická hloubka)" },
    ];

    const thinkingOptions = levels.map((l) => {
      const isCur = ctx.thinkingLevel === l.id;
      return `${isCur ? "● " : "  "}${l.id.toUpperCase()} — ${l.desc}`;
    });
    thinkingOptions.push("← Zpět do schvalování");

    const chosenThinking = await ctx.ui.select(thinkingHeader, thinkingOptions);
    if (chosenThinking && chosenThinking !== "← Zpět do schvalování") {
      const idx = thinkingOptions.indexOf(chosenThinking);
      const target = levels[idx];
      if (target && pi) {
        pi.setThinkingLevel(target.id);
        ctx.ui.notify(`Úroveň thinking nastavena na [${target.id}].`, "info");
        updateStatusline(ctx);
      }
    }
    return handleToolCallGate(event, ctx, pi);
  }

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
    const editedText = await ctx.ui.editor(`Upravit parametry nástroje ${event.toolName} (JSON):`, rawPreview);
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
      } catch {
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
