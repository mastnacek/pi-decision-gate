// Extracted from gate.ts to keep modules focused.
// gate.ts — hlavní logika zachytávání a schvalování rozhodnutí modelu

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type DecisionRecord,
	type ModelSuitability,
	type ThinkingRecommendation,
} from "./types";
import {
	ELDRITCH_CYAN,
	ELDRITCH_DIM,
	ELDRITCH_GRAY,
	ELDRITCH_PURPLE,
	ELDRITCH_TEXT,
	paint,
} from "./status";
import {
	state,
} from "./config";

/**
 * Uloží záznam o rozhodnutí do auditního logu (.pi/decision-gate/decisions.jsonl)
 */
export function logDecision(record: DecisionRecord, cwd?: string): void {
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
export function buildDecisionVerdictLine(
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
