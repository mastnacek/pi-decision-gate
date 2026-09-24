// index.ts — vstupní bod rozšíření pi-decision-gate

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerGateCommands } from "./commands.js";
import { handleToolCallGate } from "./gate.js";
import {
  refreshStatuslineAsync,
  updateStatusline,
} from "./status.js";

// Cesta ke skriptu, který osvěží katalog modelů z OpenRouteru
const MODELS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "scripts", "fetch-models.mjs");

// Držíme referenci na běžící child, aby ho session_shutdown mohl ukončit.
let modelCatalogChild: ChildProcess | null = null;

/**
 * Spustí asynchronně skript pro osvěžení models.json (neblokuje sezení).
 */
function refreshModelCatalog(): void {
  try {
    const child = spawn(process.execPath, [MODELS_SCRIPT], { stdio: "ignore" });
    modelCatalogChild = child;
    const forget = () => {
      if (modelCatalogChild === child) modelCatalogChild = null;
    };
    child.on("error", forget);
    child.on("exit", forget);
  } catch {
    modelCatalogChild = null;
  }
}

export default function (pi: ExtensionAPI): void {
  /** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
  const unsubscribers: Array<() => void> = [];

  /** Retain a `pi.on()` return value; older engine typings declare it void. */
  const track = (result: unknown): void => {
    if (typeof result === "function") unsubscribers.push(result as () => void);
  };

  // 1. Inicializace při startu sezení
  track(pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    loadConfig(ctx.cwd);
    updateStatusline(ctx);
    // Osvěží models.json z OpenRouteru na pozadí (neblokuje)
    refreshModelCatalog();
    // Asynchronní načtení kurzu ČNB a zůstatku OpenRouteru
    await refreshStatuslineAsync(ctx);
  }));

  // 2. Reakce na změnu modelu v sezení
  track(pi.on("model_select", async (_event, ctx: ExtensionContext) => {
    updateStatusline(ctx);
  }));

  // 2b. Úklid při ukončení sezení — zastaví případný běžící refresh child
  // (AGENTS.md §4/§6).
  pi.on("session_shutdown", () => {
    while (unsubscribers.length > 0) unsubscribers.pop()?.();
    if (modelCatalogChild && !modelCatalogChild.killed) {
      try {
        modelCatalogChild.kill();
      } catch {
        /* already gone */
      }
    }
    modelCatalogChild = null;
  });

  // 3. Zachytávání akcí modelu před provedením
  track(pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    return handleToolCallGate(event, ctx, pi);
  }));

  // 4. Registrace příkazů s líným doplňováním parametrů
  registerGateCommands(pi);
}
