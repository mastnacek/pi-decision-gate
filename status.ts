// status.ts — statusline footer, formátování měny v Kč, indikátory a česká nápověda

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cachedBalance, cachedUsdToCzkRate, fmtSmallAmount, getOpenRouterBalance, getUsdToCzkRate } from "./balance";
import { state } from "./config";
import type { DecisionGateConfig } from "./types";

export const STATUS_KEY = "decision-gate";

// ============================================================================
// Autentická Eldritch ANSI paleta (shodná s eldritch.json)
// ============================================================================
export const ELDRITCH_BG = "\x1b[48;2;33;35;55m";              // #212337
export const ELDRITCH_BG_ALT = "\x1b[48;2;40;43;67m";          // #282b43
export const ELDRITCH_PURPLE = "\x1b[38;2;164;140;242m";      // #a48cf2 — accent
export const ELDRITCH_PURPLE_LIGHT = "\x1b[38;2;217;159;253m"; // #d99ffd — customMessageLabel / nadpisy
export const ELDRITCH_PURPLE_DARK = "\x1b[38;2;98;84;145m";   // #625491
export const ELDRITCH_CYAN = "\x1b[38;2;4;209;249m";          // #04d1f9 — toolTitle / borderAccent / klíče
export const ELDRITCH_GREEN = "\x1b[38;2;55;244;153m";        // #37f499 — success / safe / kód
export const ELDRITCH_YELLOW = "\x1b[38;2;241;252;121m";      // #f1fc79 — warning / stringy
export const ELDRITCH_RED = "\x1b[38;2;241;108;117m";         // #f16c75 — error / destructive
export const ELDRITCH_ORANGE = "\x1b[38;2;247;198;127m";      // #f7c67f — currency / cost / čísla
export const ELDRITCH_PINK = "\x1b[38;2;242;101;181m";        // #f265b5 — keywords / booleans
export const ELDRITCH_GRAY = "\x1b[38;2;165;175;194m";        // #a5afc2 — muted text
export const ELDRITCH_DIM = "\x1b[38;2;95;107;138m";          // #5f6b8a — dim / oddělovače / rámečky
export const ELDRITCH_TEXT = "\x1b[38;2;235;250;250m";        // #ebfafa — hlavní text
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_RESET = "\x1b[0m";

// Zpětná kompatibilita pro stávající importy
export const ANSI_AMBER = ELDRITCH_ORANGE;
export const ANSI_GREEN = ELDRITCH_GREEN;
export const ANSI_CYAN = ELDRITCH_CYAN;
export const ANSI_LAVENDER = ELDRITCH_PURPLE;
export const ANSI_PURPLE = ELDRITCH_PURPLE;
export const ANSI_PURPLE_LIGHT = ELDRITCH_PURPLE_LIGHT;
export const ANSI_RED = ELDRITCH_RED;
export const ANSI_DIM = ELDRITCH_DIM;
export const ANSI_GRAY = ELDRITCH_GRAY;
export const ANSI_YELLOW = ELDRITCH_YELLOW;
export const ANSI_ORANGE = ELDRITCH_ORANGE;
export const ANSI_PINK = ELDRITCH_PINK;
export const ANSI_TEXT = ELDRITCH_TEXT;

export function paint(color: string, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

/**
 * Syntax highlighter pro formátovaný JSON v autentických barvách tématu Eldritch
 */
export function highlightJsonEldritch(jsonStr: string): string {
  return jsonStr
    .split("\n")
    .map((line) => {
      return line.replace(
        /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)|([{}[\],])/g,
        (_match, str, colon, boolOrNull, num, punct) => {
          if (str) {
            if (colon) {
              return `${ELDRITCH_CYAN}${str}${ANSI_RESET}${paint(ELDRITCH_DIM, colon)}`;
            }
            return `${ELDRITCH_YELLOW}${str}${ANSI_RESET}`;
          }
          if (boolOrNull) {
            if (boolOrNull === "null") return paint(ELDRITCH_DIM, boolOrNull);
            return paint(ELDRITCH_PINK, boolOrNull);
          }
          if (num) return paint(ELDRITCH_ORANGE, num);
          if (punct) return paint(ELDRITCH_DIM, punct);
          return _match;
        },
      );
    })
    .join("\n");
}

export function formatToggleBadge(enabled: boolean): string {
  return enabled
    ? `${ANSI_BOLD}${ELDRITCH_GREEN}● ON${ANSI_RESET}`
    : `${ELDRITCH_DIM}${ELDRITCH_RED}○ OFF${ANSI_RESET}`;
}

export function formatChoice(
  choices: Array<{ value: string; label?: string } | string>,
  activeValue: string | boolean,
): string {
  const activeStr = typeof activeValue === "boolean" ? (activeValue ? "on" : "off") : activeValue.toLowerCase();

  return choices
    .map((c) => {
      const val = typeof c === "string" ? c : c.value;
      const lbl = typeof c === "string" ? c : (c.label ?? c.value);
      if (val.toLowerCase() === activeStr) {
        return `${ANSI_BOLD}${ELDRITCH_PURPLE_LIGHT}● ${lbl}${ANSI_RESET}`;
      }
      return `${ELDRITCH_DIM}${lbl}${ANSI_RESET}`;
    })
    .join(`${ELDRITCH_DIM} | ${ANSI_RESET}`);
}

/**
 * Zkrácený kód poskytovatele pro status bar
 */
function shortProvider(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "google") return "G";
  if (p === "anthropic") return "A";
  if (p === "openai") return "OAI";
  if (p === "openrouter") return "OR";
  if (p === "ollama") return "OLL";
  if (p === "deepseek") return "DS";
  return p.slice(0, 3).toUpperCase();
}

/**
 * Zkrácený název modelu pro status bar
 */
function formatShortModel(ctx?: ExtensionContext): string {
  if (!ctx?.model) return "none";
  const p = shortProvider(ctx.model.provider || "model");
  const id = ctx.model.id || "unknown";
  const slash = id.lastIndexOf("/");
  const m = slash >= 0 ? id.slice(slash + 1) : id;
  return `${p}:${m}`;
}

/**
 * Sestaví text statusbaru v jednom kompaktním segmentu
 */
export function buildStatuslineText(ctx?: ExtensionContext): string {
  const config = state.config;

  if (!config.enabled || config.mode === "off") {
    return paint(ELDRITCH_DIM, "🛡️ gate:off");
  }

  const groupSep = paint(ELDRITCH_DIM, " │ ");
  const itemSep = paint(ELDRITCH_DIM, " · ");

  // 1. Skupina: Stav a režim brány
  let modeStr = `🛡️ ${config.mode}`;
  if (config.mode === "risky") {
    modeStr += `(≥${config.threshold})`;
  }
  const gateGroup = [paint(ELDRITCH_CYAN, modeStr)];

  // 2. Skupina: Aktivní model navrhující akce
  const modelText = formatShortModel(ctx);
  gateGroup.push(paint(ELDRITCH_PURPLE, modelText));

  // 3. Skupina: Počet schválených a zablokovaných rozhodnutí
  const statsText = `${paint(ELDRITCH_GREEN, `✓${state.approvedCount}`)}${itemSep}${paint(ELDRITCH_RED, `✗${state.blockedCount}`)}`;

  // 4. Skupina: Spotřeba v Kč a kredit na OpenRouteru
  const costUsd = state.sessionCostUsd;
  const rate = cachedUsdToCzkRate();
  const bal = cachedBalance();

  let moneyStr = "💳 ";
  if (typeof rate === "number" && rate > 0) {
    const costCzk = costUsd * rate;
    moneyStr += paint(ELDRITCH_ORANGE, `${fmtSmallAmount(costCzk)} Kč`);
    if (bal) {
      const balCzk = bal.remaining * rate;
      moneyStr += `${paint(ELDRITCH_DIM, " / ")}${paint(ELDRITCH_GREEN, `${fmtSmallAmount(balCzk)} Kč`)}`;
    }
  } else {
    moneyStr += paint(ELDRITCH_ORANGE, `$${fmtSmallAmount(costUsd)}`);
    if (bal) {
      moneyStr += `${paint(ELDRITCH_DIM, " / ")}${paint(ELDRITCH_GREEN, `$${bal.remaining.toFixed(2)}`)}`;
    }
  }

  return [gateGroup.join(itemSep), statsText, moneyStr].join(groupSep);
}

/**
 * Aktualizuje statusbar v Pi UI
 */
export function updateStatusline(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, buildStatuslineText(ctx));
}

/**
 * Načte kurz a kredit a překreslí statusbar
 */
export async function refreshStatuslineAsync(ctx: ExtensionContext): Promise<void> {
  try {
    await Promise.all([
      getUsdToCzkRate(ctx.signal),
      getOpenRouterBalance(ctx),
    ]);
  } catch {
    // tiše selže
  }
  updateStatusline(ctx);
}

/**
 * Sestaví kompletní českou nápovědu s popisem všech parametrů
 */
export function buildCzechHelp(config: DecisionGateConfig): string {
  const rate = cachedUsdToCzkRate();
  const costUsd = state.sessionCostUsd;
  const costCzk = typeof rate === "number" && rate > 0 ? costUsd * rate : undefined;
  const costStr = costCzk !== undefined ? `${fmtSmallAmount(costCzk)} Kč ($${fmtSmallAmount(costUsd)})` : `$${fmtSmallAmount(costUsd)}`;

  return [
    `${ANSI_BOLD}${ELDRITCH_PURPLE_LIGHT}🛡️  pi-decision-gate${ANSI_RESET} — ${paint(ELDRITCH_GRAY, "Brána schvalování rozhodnutí modelu s kontrolou přes Jev")}`,
    paint(ELDRITCH_DIM, "Zajišťuje plnou kontrolu uživatele nad akcemi modelu s hodnocením rizik a cenou v Kč."),
    "",
    `${ANSI_BOLD}${ELDRITCH_PURPLE}Příkazy & Konfigurace:${ANSI_RESET}`,
    `  ${paint(ELDRITCH_CYAN, "/gate on|off")}                   — hlavní vypínač brány (${formatChoice(["on", "off"], config.enabled)})`,
    `  ${paint(ELDRITCH_CYAN, "/gate mode <režim>")}             — režim schvalování (${formatChoice(["always", "risky", "destructive", "off"], config.mode)})`,
    `                                   • always: schvalovat každou akci (kromě výjimek)`,
    `                                   • risky: schvalovat akce s rizikem Jev ≥ práh`,
    `                                   • destructive: schvalovat jen nevratné akce (rm, reset, drop...)`,
    `                                   • off: brána je neaktivní`,
    `  ${paint(ELDRITCH_CYAN, "/gate threshold <0.1-1.0>")}      — práh rizika pro režim 'risky' (aktuálně: ${paint(ELDRITCH_YELLOW, String(config.threshold))})`,
    `  ${paint(ELDRITCH_CYAN, "/gate jev on|off")}               — hodnocení rizik přes model Jev na OpenRouteru (${formatToggleBadge(config.useJev)})`,
    `  ${paint(ELDRITCH_CYAN, "/gate edit on|off")}              — možnost interaktivně upravit argumenty (${formatToggleBadge(config.allowEdit)})`,
    `  ${paint(ELDRITCH_CYAN, "/gate exempt list")}              — seznam osvobozených nástrojů [${paint(ELDRITCH_YELLOW, config.exemptTools.join(", "))}]`,
    `  ${paint(ELDRITCH_CYAN, "/gate exempt add <nástroj>")}     — přidá nástroj do výjimek (např. read)`,
    `  ${paint(ELDRITCH_CYAN, "/gate exempt remove <nástroj>")}  — odebere nástroj z výjimek`,
    `  ${paint(ELDRITCH_CYAN, "/gate models")}                   — přehled modelů používaných v sezeních za posledních 7 dní`,
    `  ${paint(ELDRITCH_CYAN, "/gate status")}                   — zobrazí detailní diagnostiku, statistiky a náklady`,
    `  ${paint(ELDRITCH_CYAN, "/gate balance [refresh]")}        — stav kreditu na OpenRouteru a kurz ČNB`,
    `  ${paint(ELDRITCH_CYAN, "/gate reset")}                    — obnoví výchozí nastavení`,
    "",
    `${ELDRITCH_DIM}Tip: Přidejte přepínač --global pro trvalé uložení do ~/.pi/agent/pi-decision-gate.json${ANSI_RESET}`,
    "",
    `${ANSI_BOLD}${ELDRITCH_PURPLE}Aktuální stav sezení:${ANSI_RESET}`,
    `  • Režim: ${paint(ELDRITCH_GREEN, config.mode)} | Jev posuzování: ${formatToggleBadge(config.useJev)} | Editace: ${formatToggleBadge(config.allowEdit)}`,
    `  • Schváleno: ${paint(ELDRITCH_GREEN, String(state.approvedCount))} | Zablokováno: ${paint(ELDRITCH_RED, String(state.blockedCount))} | Upraveno: ${paint(ELDRITCH_YELLOW, String(state.editedCount))}`,
    `  • Útrata sezení za Jev: ${paint(ELDRITCH_ORANGE, costStr)}`,
  ].join("\n");
}
