// index.ts — vstupní bod rozšíření pi-decision-gate

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  clearBalanceCache,
  fmtSmallAmount,
  getOpenRouterBalance,
  getUsdToCzkRate,
} from "./balance";
import {
  COMMAND_DOCS,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  state,
} from "./config";
import { handleToolCallGate } from "./gate";
import {
  formatModelsReport,
  getRecentAndConfiguredModels,
  invalidateModelsCache,
} from "./models";
import {
  buildCzechHelp,
  refreshStatuslineAsync,
  updateStatusline,
} from "./status";
import type { ApprovalMode } from "./types";

// Cesta ke skriptu, který osvěží katalog modelů z OpenRouteru
const MODELS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "scripts", "fetch-models.mjs");

/**
 * Spustí asynchronně skript pro osvěžení models.json (neblokuje sezení).
 */
function refreshModelCatalog(): void {
  try {
    const child = spawn(process.execPath, [MODELS_SCRIPT], { stdio: "ignore" });
    child.on("error", () => {
      // Chyba spuštění skriptu nesmí ovlivnit sezení.
    });
  } catch {
    // ignorujeme
  }
}

export default function (pi: ExtensionAPI): void {
  // 1. Inicializace při startu sezení
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    loadConfig(ctx.cwd);
    updateStatusline(ctx);
    // Osvěží models.json z OpenRouteru na pozadí (neblokuje)
    refreshModelCatalog();
    // Asynchronní načtení kurzu ČNB a zůstatku OpenRouteru
    await refreshStatuslineAsync(ctx);
  });

  // 2. Reakce na změnu modelu v sezení
  pi.on("model_select", async (_event, ctx: ExtensionContext) => {
    updateStatusline(ctx);
  });

  // 3. Zachytávání akcí modelu před provedením
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    return handleToolCallGate(event, ctx, pi);
  });

  // 4. Registrace příkazů s líným doplňováním parametrů
  const registerGateCommands = (cmdName: string) => {
    pi.registerCommand(cmdName, {
      description: "Správa brány schvalování rozhodnutí modelu (pi-decision-gate)",
      getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
        const tokens = prefix.split(/\s+/).filter(Boolean);
        const trailingSpace = /\s$/.test(prefix);
        const normalized = prefix.toLowerCase();

        // N-tá úroveň autocompletu
        if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
          const sub = tokens[0]?.toLowerCase();

          if (sub === "mode") {
            const modes: Array<{ val: ApprovalMode; desc: string }> = [
              { val: "always", desc: "Schvalovat každou neosvobozenou akci" },
              { val: "risky", desc: "Schvalovat akce s rizikem Jev ≥ práh" },
              { val: "destructive", desc: "Schvalovat pouze destruktivní akce" },
              { val: "off", desc: "Vypnout bránu" },
            ];
            const items = modes.map((m) => ({
              value: `mode ${m.val}`,
              label: `mode ${m.val}`,
              description: m.desc,
            }));
            const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalized));
            return filtered.length > 0 ? filtered : null;
          }

          if (sub === "jev" || sub === "edit" || sub === "on" || sub === "off") {
            const toggles = [
              { value: `${sub} on`, label: `${sub} on`, description: `Zapnout ${sub}` },
              { value: `${sub} off`, label: `${sub} off`, description: `Vypnout ${sub}` },
            ];
            const filtered = toggles.filter((i) => i.value.toLowerCase().startsWith(normalized));
            return filtered.length > 0 ? filtered : null;
          }

          if (sub === "threshold") {
            const thresholds = ["0.3", "0.5", "0.7", "0.9"].map((t) => ({
              value: `threshold ${t}`,
              label: `threshold ${t}`,
              description: `Práh rizika ${t}`,
            }));
            const filtered = thresholds.filter((i) => i.value.toLowerCase().startsWith(normalized));
            return filtered.length > 0 ? filtered : null;
          }

          if (sub === "exempt") {
            const subs = [
              { value: "exempt list", label: "exempt list", description: "Zobrazit osvobozené nástroje" },
              { value: "exempt add", label: "exempt add <nástroj>", description: "Přidat nástroj do výjimek" },
              { value: "exempt remove", label: "exempt remove <nástroj>", description: "Odebrat nástroj z výjimek" },
            ];
            const filtered = subs.filter((i) => i.value.toLowerCase().startsWith(normalized));
            return filtered.length > 0 ? filtered : null;
          }

          if (sub === "balance") {
            const items = [
              { value: "balance refresh", label: "balance refresh", description: "Vynutit obnovení kreditu a kurzu" },
            ];
            const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalized));
            return filtered.length > 0 ? filtered : null;
          }

          return null;
        }

        // 1. úroveň autocompletu — podpříkazy ze slovníku
        const typed = (tokens[0] ?? "").toLowerCase();
        const items = Object.entries(COMMAND_DOCS)
          .filter(([key]) => key.toLowerCase().startsWith(typed))
          .map(([value, description]) => ({ value, label: value, description }));

        return items.length > 0 ? items : null;
      },

      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const trimmed = args.trim();
        const tokens = trimmed.split(/\s+/).filter(Boolean);
        const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
        const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");

        const subcommand = (cleanTokens[0] ?? "").toLowerCase();
        const arg1 = cleanTokens[1]?.toLowerCase();
        const arg2 = cleanTokens[2];

        // Nápověda (výchozí stav)
        if (!subcommand || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
          ctx.ui.notify(buildCzechHelp(state.config), "info");
          return;
        }

        switch (subcommand) {
          case "on": {
            state.config.enabled = true;
            saveConfig(state.config, isGlobal, ctx.cwd);
            updateStatusline(ctx);
            ctx.ui.notify(`Brána rozhodování ZAPNUTA (režim: ${state.config.mode})`, "info");
            break;
          }

          case "off": {
            state.config.enabled = false;
            saveConfig(state.config, isGlobal, ctx.cwd);
            updateStatusline(ctx);
            ctx.ui.notify("Brána rozhodování VYPNUTA", "info");
            break;
          }

          case "mode": {
            const validModes: ApprovalMode[] = ["always", "risky", "destructive", "off"];
            if (arg1 && validModes.includes(arg1 as ApprovalMode)) {
              state.config.mode = arg1 as ApprovalMode;
              if (arg1 !== "off") state.config.enabled = true;
              saveConfig(state.config, isGlobal, ctx.cwd);
              updateStatusline(ctx);
              ctx.ui.notify(`Režim schvalování nastaven na: ${arg1}`, "info");
            } else {
              ctx.ui.notify(`Aktuální režim: ${state.config.mode}. Možnosti: always | risky | destructive | off`, "warning");
            }
            break;
          }

          case "threshold": {
            const num = parseFloat(arg1 ?? "");
            if (!isNaN(num) && num >= 0.0 && num <= 1.0) {
              state.config.threshold = num;
              saveConfig(state.config, isGlobal, ctx.cwd);
              updateStatusline(ctx);
              ctx.ui.notify(`Práh rizika Jev nastaven na: ${num}`, "info");
            } else {
              ctx.ui.notify(`Neplatný práh. Zadejte číslo mezi 0.0 a 1.0 (např. /gate threshold 0.7)`, "warning");
            }
            break;
          }

          case "jev": {
            if (arg1 === "on" || arg1 === "true") {
              state.config.useJev = true;
              saveConfig(state.config, isGlobal, ctx.cwd);
              updateStatusline(ctx);
              ctx.ui.notify("Posuzování rizik přes Jev (OpenRouter) POVOLENO", "info");
            } else if (arg1 === "off" || arg1 === "false") {
              state.config.useJev = false;
              saveConfig(state.config, isGlobal, ctx.cwd);
              updateStatusline(ctx);
              ctx.ui.notify("Posuzování rizik přes Jev VYPNUTO (použije se offline heuristika)", "info");
            } else {
              ctx.ui.notify(`Jev posuzování je: ${state.config.useJev ? "on" : "off"}. Použijte: /gate jev on|off`, "info");
            }
            break;
          }

          case "edit": {
            if (arg1 === "on" || arg1 === "true") {
              state.config.allowEdit = true;
              saveConfig(state.config, isGlobal, ctx.cwd);
              ctx.ui.notify("Úprava argumentů před schválením POVOLENA", "info");
            } else if (arg1 === "off" || arg1 === "false") {
              state.config.allowEdit = false;
              saveConfig(state.config, isGlobal, ctx.cwd);
              ctx.ui.notify("Úprava argumentů před schválením VYPNUTA", "info");
            } else {
              ctx.ui.notify(`Úprava argumentů je: ${state.config.allowEdit ? "on" : "off"}. Použijte: /gate edit on|off`, "info");
            }
            break;
          }

          case "exempt": {
            if (arg1 === "add" && arg2) {
              if (!state.config.exemptTools.includes(arg2)) {
                state.config.exemptTools.push(arg2);
                saveConfig(state.config, isGlobal, ctx.cwd);
                ctx.ui.notify(`Nástroj '${arg2}' přidán do trvalých výjimek.`, "info");
              } else {
                ctx.ui.notify(`Nástroj '${arg2}' již ve výjimkách je.`, "info");
              }
            } else if (arg1 === "remove" && arg2) {
              state.config.exemptTools = state.config.exemptTools.filter((t) => t !== arg2);
              saveConfig(state.config, isGlobal, ctx.cwd);
              ctx.ui.notify(`Nástroj '${arg2}' odebrán z výjimek.`, "info");
            } else {
              const allExempt = Array.from(new Set([...state.config.exemptTools, ...state.sessionExemptions]));
              ctx.ui.notify(`Osvobozené nástroje: [${allExempt.join(", ")}]`, "info");
            }
            break;
          }

          case "models": {
            invalidateModelsCache();
            const models = getRecentAndConfiguredModels(ctx, 7);
            const activeKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
            const report = formatModelsReport(models, activeKey);
            ctx.ui.notify(report, "info");
            break;
          }

          case "status": {
            ctx.ui.notify(buildCzechHelp(state.config), "info");
            break;
          }

          case "balance": {
            if (arg1 === "refresh") {
              clearBalanceCache();
            }
            const [bal, rate] = await Promise.all([
              getOpenRouterBalance(ctx),
              getUsdToCzkRate(ctx.signal),
            ]);
            let text = "Stav OpenRouteru a měny:\n";
            if (bal) {
              const remUsd = bal.remaining.toFixed(2);
              const remCzk = rate ? `${(bal.remaining * rate).toFixed(2)} Kč` : "n/a";
              text += `• Zůstatek kreditu: $${remUsd} (${remCzk})\n`;
              text += `• Celková spotřeba: $${bal.usage.toFixed(2)}\n`;
            } else {
              text += `• Zůstatek kreditu: nelze načíst (zkontrolujte API klíč)\n`;
            }
            text += `• Kurz ČNB: ${rate ? `${rate.toFixed(2)} Kč/USD` : "nenačteno"}\n`;
            text += `• Spotřeba tohoto sezení na Jev: $${fmtSmallAmount(state.sessionCostUsd)}`;
            if (rate) {
              text += ` (${fmtSmallAmount(state.sessionCostUsd * rate)} Kč)`;
            }
            ctx.ui.notify(text, "info");
            updateStatusline(ctx);
            break;
          }

          case "reset": {
            state.config = { ...DEFAULT_CONFIG };
            state.sessionExemptions.clear();
            saveConfig(state.config, isGlobal, ctx.cwd);
            updateStatusline(ctx);
            ctx.ui.notify("Nastavení brány rozhodování obnoveno na výchozí hodnoty.", "info");
            break;
          }

          default: {
            ctx.ui.notify(`Neznámý příkaz "${subcommand}". Použijte /${cmdName} help`, "warning");
            break;
          }
        }
      },
    });
  };

  registerGateCommands("gate");
  registerGateCommands("decision-gate");
}
