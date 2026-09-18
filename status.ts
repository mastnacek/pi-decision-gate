// status.ts — statusline footer, formátování měny v Kč, indikátory a česká nápověda

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cachedBalance, cachedUsdToCzkRate, fmtSmallAmount, getOpenRouterBalance, getUsdToCzkRate } from "./balance";
import { state } from "./config";
import type { DecisionGateConfig } from "./types";

export const STATUS_KEY = "decision-gate";

// ANSI paleta barev přívětivá pro tmavá i světlá témata
export const ANSI_AMBER = "\x1b[38;2;218;165;32m";
export const ANSI_GREEN = "\x1b[38;2;95;200;140m";
export const ANSI_CYAN = "\x1b[38;2;95;200;230m";
export const ANSI_LAVENDER = "\x1b[38;2;170;160;220m";
export const ANSI_RED = "\x1b[38;2;210;100;100m";
export const ANSI_DIM = "\x1b[38;2;120;124;140m";
export const ANSI_YELLOW = "\x1b[38;2;230;200;90m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_RESET = "\x1b[0m";

export function paint(color: string, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

export function formatToggleBadge(enabled: boolean): string {
  return enabled
    ? `${ANSI_BOLD}${ANSI_GREEN}● ON${ANSI_RESET}`
    : `${ANSI_DIM}${ANSI_RED}○ OFF${ANSI_RESET}`;
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
        return `${ANSI_BOLD}${ANSI_GREEN}● ${lbl}${ANSI_RESET}`;
      }
      return `${ANSI_DIM}${lbl}${ANSI_RESET}`;
    })
    .join(`${ANSI_DIM}|${ANSI_RESET}`);
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
    return paint(ANSI_DIM, "🛡️ gate:off");
  }

  const groupSep = paint(ANSI_DIM, " │ ");
  const itemSep = paint(ANSI_DIM, " · ");

  // 1. Skupina: Stav a režim brány
  let modeStr = `🛡️ ${config.mode}`;
  if (config.mode === "risky") {
    modeStr += `(≥${config.threshold})`;
  }
  const gateGroup = [paint(ANSI_GREEN, modeStr)];

  // 2. Skupina: Aktivní model navrhující akce
  const modelText = formatShortModel(ctx);
  gateGroup.push(paint(ANSI_LAVENDER, modelText));

  // 3. Skupina: Počet schválených a zablokovaných rozhodnutí
  const statsText = `${paint(ANSI_GREEN, `✓${state.approvedCount}`)}${itemSep}${paint(ANSI_RED, `✗${state.blockedCount}`)}`;

  // 4. Skupina: Spotřeba v Kč a kredit na OpenRouteru
  const costUsd = state.sessionCostUsd;
  const rate = cachedUsdToCzkRate();
  const bal = cachedBalance();

  let moneyStr = "💳 ";
  if (typeof rate === "number" && rate > 0) {
    const costCzk = costUsd * rate;
    moneyStr += paint(ANSI_AMBER, `${fmtSmallAmount(costCzk)} Kč`);
    if (bal) {
      const balCzk = bal.remaining * rate;
      moneyStr += `${paint(ANSI_DIM, " / ")}${paint(ANSI_GREEN, `${fmtSmallAmount(balCzk)} Kč`)}`;
    }
  } else {
    moneyStr += paint(ANSI_AMBER, `$${fmtSmallAmount(costUsd)}`);
    if (bal) {
      moneyStr += `${paint(ANSI_DIM, " / ")}${paint(ANSI_GREEN, `$${bal.remaining.toFixed(2)}`)}`;
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
    `${ANSI_BOLD}${ANSI_CYAN}🛡️ pi-decision-gate${ANSI_RESET} — Brána schvalování rozhodnutí modelu s kontrolou přes Jev`,
    "Zajišťuje plnou kontrolu uživatele nad akcemi modelu. U každého volání nástroje zobrazuje navrhující model, parametry a odhad rizika.",
    "",
    `${ANSI_BOLD}Příkazy & Konfigurace:${ANSI_RESET}`,
    `  /gate on|off                   — hlavní vypínač brány (${formatChoice(["on", "off"], config.enabled)})`,
    `  /gate mode <režim>             — režim schvalování (${formatChoice(["always", "risky", "destructive", "off"], config.mode)})`,
    `                                   • always: schvalovat každou akci (kromě výjimek)`,
    `                                   • risky: schvalovat akce s rizikem Jev ≥ práh`,
    `                                   • destructive: schvalovat jen nevratné akce (rm, reset, drop...)`,
    `                                   • off: brána je neaktivní`,
    `  /gate threshold <0.1-1.0>      — práh rizika pro režim 'risky' (aktuálně: ${paint(ANSI_CYAN, String(config.threshold))})`,
    `  /gate jev on|off               — hodnocení rizik přes model Jev na OpenRouteru (${formatToggleBadge(config.useJev)})`,
    `  /gate edit on|off              — možnost interaktivně upravit argumenty před schválením (${formatToggleBadge(config.allowEdit)})`,
    `  /gate exempt list              — seznam osvobozených nástrojů [${config.exemptTools.join(", ")}]`,
    `  /gate exempt add <nástroj>     — přidá nástroj do výjimek (např. read)`,
    `  /gate exempt remove <nástroj>  — odebere nástroj z výjimek`,
    `  /gate models                   — přehled modelů používaných v sezeních za posledních 7 dní`,
    `  /gate status                   — zobrazí detailní diagnostiku, statistiky a náklady`,
    `  /gate balance [refresh]        — stav kreditu na OpenRouteru a kurz ČNB`,
    `  /gate reset                    — obnoví výchozí nastavení`,
    "",
    `${ANSI_DIM}Tip: Přidejte přepínač --global pro trvalé uložení do ~/.pi/agent/pi-decision-gate.json${ANSI_RESET}`,
    "",
    `${ANSI_BOLD}Aktuální stav sezení:${ANSI_RESET}`,
    `  • Režim: ${paint(ANSI_GREEN, config.mode)} | Jev posuzování: ${formatToggleBadge(config.useJev)} | Editace: ${formatToggleBadge(config.allowEdit)}`,
    `  • Schváleno: ${paint(ANSI_GREEN, String(state.approvedCount))} | Zablokováno: ${paint(ANSI_RED, String(state.blockedCount))} | Upraveno: ${paint(ANSI_YELLOW, String(state.editedCount))}`,
    `  • Útrata sezení za Jev: ${paint(ANSI_AMBER, costStr)}`,
  ].join("\n");
}
