// herdr.ts — integrace s Herdr workspace managerem (panes, sub-agenti, handoff)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function getHerdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/**
 * Zjistí, zda běžíme uvnitř Herdr prostředí nebo zda je Herdr server dostupný
 */
export function isHerdrEnvironment(): boolean {
  return Boolean(process.env.HERDR_ENV === "1" || process.env.HERDR_PANE_ID || process.env.HERDR_SOCKET_PATH);
}

/**
 * Zkontroluje dostupnost Herdr serveru přes CLI status
 */
export async function checkHerdrAvailability(): Promise<boolean> {
  if (!isHerdrEnvironment()) return false;
  try {
    const res = await execFileAsync(getHerdrBin(), ["status", "server"], { timeout: 1500 });
    return res.stdout.includes("status: running") || !res.stderr.includes("not running");
  } catch {
    return false;
  }
}

/**
 * Rozdělí aktuální okno v Herdr (vytvoří nový sub-pane vpravo nebo dole)
 */
export async function splitHerdrPane(options: {
  direction?: "right" | "down";
  cwd?: string;
} = {}): Promise<{ ok: boolean; paneId?: string; error?: string }> {
  const args = ["pane", "split", "--current", "--direction", options.direction ?? "right", "--no-focus"];
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }

  try {
    const res = await execFileAsync(getHerdrBin(), args, { timeout: 5000 });
    try {
      const parsed = JSON.parse(res.stdout);
      const paneId = parsed?.result?.pane?.pane_id;
      if (paneId) {
        return { ok: true, paneId };
      }
    } catch {
      // Fallback na regex, pokud stdout není JSON
      const match = res.stdout.match(/w\d+:p\d+/);
      if (match) {
        return { ok: true, paneId: match[0] };
      }
    }
    return { ok: false, error: "Herdr nerozpoznal ID nového okna" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Spustí agenta (např. Pi) v existujícím sub-pane a předá mu úvodní konfiguraci
 */
export async function startHerdrAgent(input: {
  name: string;
  kind?: "pi" | "claude" | "cursor" | "codex" | "opencode";
  paneId: string;
  model?: string;
  thinking?: string;
  theme?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const kind = input.kind ?? "pi";
  const agentArgs: string[] = [];

  if (kind === "pi") {
    agentArgs.push("--use-theme", input.theme ?? "eldritch");
    if (input.model) {
      agentArgs.push("-m", input.model);
    }
    if (input.thinking) {
      agentArgs.push("--thinking", input.thinking);
    }
  }

  const args = [
    "agent",
    "start",
    input.name,
    "--kind",
    kind,
    "--pane",
    input.paneId,
    "--timeout",
    "30000",
    "--",
    ...agentArgs,
  ];

  try {
    await execFileAsync(getHerdrBin(), args, { timeout: 35000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Odešle zadání / prompt spuštěnému agentovi v Herdr
 */
export async function promptHerdrAgent(input: {
  target: string;
  promptText: string;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const args = ["agent", "prompt", input.target, input.promptText];
  if (input.wait) {
    args.push("--wait", "--timeout", String(input.timeoutMs ?? 60000));
  }

  try {
    await execFileAsync(getHerdrBin(), args, { timeout: (input.timeoutMs ?? 60000) + 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Zavře zadaný Herdr pane
 */
export async function closeHerdrPane(paneId: string): Promise<boolean> {
  try {
    await execFileAsync(getHerdrBin(), ["pane", "close", paneId], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
