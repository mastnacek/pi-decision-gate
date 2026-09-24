// Resolves what the user chose in the approval dialog.
//
// Extracted verbatim from gate.ts: each branch keeps its original `return`, so the
// visible behaviour (approve, refuse, exempt for the session, edit the arguments)
// is unchanged. A `undefined` result means the call may proceed; `{ block: true }`
// stops it.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./config";
import { logDecision } from "./gate-log";
import { updateStatusline } from "./status";
import type { JevAssessment } from "./types";

export interface GateChoiceContext {
	event: { toolName: string; input: Record<string, unknown> };
	ctx: ExtensionContext;
	assessment: JevAssessment;
	modelProvider: string;
	modelId: string;
	modelLabel: string;
	rawPreview: string;
}

/** Returns undefined when the call may proceed, or `{ block: true }` to stop it. */
export async function resolveGateChoice(
	choice: string | undefined,
	args: GateChoiceContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const { event, ctx, assessment, modelProvider, modelId, modelLabel, rawPreview } = args;

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
