import test from "node:test";
import assert from "node:assert/strict";
import { registerGateCommands } from "../commands.js";

test("getArgumentCompletions: root includes --global", async () => {
  let commandDef = null;
  const mockPi = {
    registerCommand(name, def) {
      if (name === "gate") commandDef = def;
    },
  };
  registerGateCommands(mockPi);
  assert.ok(commandDef);

  const rootComps = await commandDef.getArgumentCompletions("");
  assert.ok(rootComps && rootComps.length > 0);
  assert.ok(rootComps.some((c) => c.value === "--global "));
  assert.ok(rootComps.some((c) => c.value === "mode "));
});

test("getArgumentCompletions: --global prefix preserves child completions", async () => {
  let commandDef = null;
  const mockPi = {
    registerCommand(name, def) {
      if (name === "gate") commandDef = def;
    },
  };
  registerGateCommands(mockPi);

  const globalComps = await commandDef.getArgumentCompletions("--global ");
  assert.ok(globalComps && globalComps.length > 0);
  assert.ok(globalComps.some((c) => c.value === "--global mode "));

  const globalModeComps = await commandDef.getArgumentCompletions("--global mode ");
  assert.ok(globalModeComps && globalModeComps.length > 0);
  assert.ok(globalModeComps.some((c) => c.value === "--global mode risky"));
  assert.ok(globalModeComps.some((c) => c.value === "--global mode off"));
});
