// Approval-dialog prompt construction: header, hints, verdict line and options.
//
// Split out of gate.ts so the decision flow stays readable. Pure formatting: no
// state is mutated and no decision is taken here.
/** Types this builder needs from the shared type module. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	JevAssessment,
	DecisionGateConfig,
	HerdrPaneRecommendation,
	ThinkingRecommendation,
} from "./types";
import { fmtSmallAmount } from "./balance";
import { buildDecisionVerdictLine } from "./gate-log";
import { isHerdrEnvironment } from "./herdr";
import {
	evaluateModelSuitability,
	getHerdrPaneRecommendation,
	getThinkingRecommendation,
} from "./models";
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
} from "./status";

export interface GatePrompt {
	header: string;
	options: string[];
	rawPreview: string;
	thinkingRec: ThinkingRecommendation;
	herdrRec: HerdrPaneRecommendation;
	quickThinkingOption: string;
	herdrPaneOption: string | undefined;
	switchModelOption: string;
	changeThinkingOption: string;
}

export function buildGatePrompt(args: {
	event: { toolName: string; input: Record<string, unknown> };
	ctx: ExtensionContext;
	assessment: JevAssessment;
	config: DecisionGateConfig;
	modelLabel: string;
	thinking: string;
	pi?: ExtensionAPI;
}): GatePrompt {
	const { event, ctx, assessment, config, modelLabel, thinking, pi } = args;

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

	return {
		header,
		options,
		rawPreview,
		thinkingRec,
		herdrRec,
		quickThinkingOption,
		herdrPaneOption,
		switchModelOption,
		changeThinkingOption,
	};
}
