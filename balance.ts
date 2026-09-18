// balance.ts — kurz USD/CZK (ČNB + ECB záloha), kredit na OpenRouteru a formátování měny

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BalanceInfo } from "./types";

const CNB_DAILY_URL = "https://api.cnb.cz/cnbapi/exrates/daily?lang=EN";
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CZK";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const BALANCE_TTL_MS = 5 * 60 * 1000;

let fxCache: { rate: number; date: string } | undefined;
let balanceCache: { info: BalanceInfo; ts: number } | undefined;

export function cachedUsdToCzkRate(): number | undefined {
  return fxCache?.rate;
}

export function cachedBalance(): BalanceInfo | undefined {
  return balanceCache?.info;
}

export function clearBalanceCache(): void {
  balanceCache = undefined;
}

/**
 * Získá denní kurz ČNB (Česká národní banka) s fallbackem na ECB (Frankfurter).
 */
export async function getUsdToCzkRate(signal?: AbortSignal): Promise<number | undefined> {
  const today = new Date().toISOString().slice(0, 10);
  if (fxCache && fxCache.date === today) return fxCache.rate;

  // 1. Primární: Denní kurz ČNB
  try {
    const res = await fetch(CNB_DAILY_URL, { signal });
    if (res.ok) {
      const data = (await res.json()) as {
        rates?: Array<{ currencyCode: string; amount: number; rate: number }>;
      };
      const usd = data.rates?.find((r) => r.currencyCode === "USD");
      if (usd) {
        const rate = usd.amount > 0 ? usd.rate / usd.amount : usd.rate;
        fxCache = { rate, date: today };
        return rate;
      }
    }
  } catch {
    // ČNB selhalo, zkusíme fallback
  }

  // 2. Fallback: Frankfurter (ECB)
  try {
    const res = await fetch(FRANKFURTER_URL, { signal });
    if (res.ok) {
      const data = (await res.json()) as { rates?: { CZK?: number } };
      const rate = data.rates?.CZK;
      if (typeof rate === "number" && rate > 0) {
        fxCache = { rate, date: today };
        return rate;
      }
    }
  } catch {
    // fallback selhal
  }

  return fxCache?.rate;
}

/**
 * Vyhledá OpenRouter API klíč / access token:
 * 1. process.env.OPENROUTER_API_KEY
 * 2. ~/.pi/agent/auth.json (OAuth access token nebo klíč)
 * 3. ctx.modelRegistry (pokud je dostupný)
 */
export async function getOpenRouterApiKey(ctx?: ExtensionContext): Promise<string | undefined> {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  // Hledání v ~/.pi/agent/auth.json
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      const or = auth.openrouter;
      if (typeof or === "string" && or) return or;
      if (typeof or?.access === "string" && or.access) return or.access;
      if (typeof or?.apiKey === "string" && or.apiKey) return or.apiKey;
    }
  } catch {
    // ignorujeme chybu
  }

  // ctx.modelRegistry provider auth
  if (ctx?.modelRegistry) {
    try {
      const provider = ctx.modelRegistry.getProvider("openrouter");
      if (provider) {
        const auth = await (ctx.modelRegistry as any).getProviderAuth?.("openrouter");
        if (auth?.apiKey) return auth.apiKey;
      }
    } catch {
      // ignorujeme chybu
    }
  }

  return undefined;
}

/**
 * Načte zůstatek na OpenRouter účtu.
 */
export async function getOpenRouterBalance(ctx?: ExtensionContext): Promise<BalanceInfo | undefined> {
  if (balanceCache && Date.now() - balanceCache.ts < BALANCE_TTL_MS) {
    return balanceCache.info;
  }

  const apiKey = await getOpenRouterApiKey(ctx);
  if (!apiKey) return undefined;

  try {
    const res = await fetch(OPENROUTER_CREDITS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctx?.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      if (data.data) {
        const info: BalanceInfo = {
          remaining: Math.max(0, (data.data.total_credits ?? 0) - (data.data.total_usage ?? 0)),
          usage: data.data.total_usage ?? 0,
        };
        balanceCache = { info, ts: Date.now() };
        return info;
      }
    }
  } catch {
    // ignorujeme chybu
  }

  return undefined;
}

/**
 * Formátování malých částek (např. 0.000468 Kč).
 */
export function fmtSmallAmount(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return n.toFixed(decimals);
}
