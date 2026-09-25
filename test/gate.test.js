// Characterization tests for the tool-call approval gate.
//
// These pin the behaviour of `handleToolCallGate` — including the security-relevant
// decisions (which modes block, what the headless path does) — so the module can be
// refactored for the line-limit rule without changing semantics.
//
// They were written against the unmodified module and describe its real behaviour.
// One assertion has since been changed deliberately: the headless path used to grant
// approvals without writing an audit record; that gap is now fixed, so the test
// asserts the record is written.
//
// `state.config.useJev === false` keeps `assessActionWithJev` on its deterministic
// offline fallback (risk 2.0 for destructive/sensitive input, else 0.2), so no
// network or stubbing is involved.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, state } from "../config.js";
import { handleToolCallGate } from "../gate.js";

const SAFE = () => ({ toolName: "bash", input: { command: "ls -la" } });
const DESTRUCTIVE = () => ({ toolName: "bash", input: { command: "rm -rf ./build" } });
const SENSITIVE = () => ({
	toolName: "bash",
	input: { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx' https://example.test" },
});
const EXEMPT = () => ({ toolName: "read", input: { path: "a.txt" } });

let cwd;

const logFile = () => join(cwd, ".pi", "decision-gate", "decisions.jsonl");
const logRecords = () =>
	existsSync(logFile())
		? readFileSync(logFile(), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

/** Mock ExtensionContext; `select` receives the real option list. */
function makeCtx({ hasUI = false, select, editor } = {}) {
	const notifications = [];
	const statuses = [];
	const seenOptions = [];
	const ctx = {
		cwd,
		hasUI,
		mode: hasUI ? "tui" : "print",
		model: { provider: "openrouter", id: "test-model" },
		thinkingLevel: "medium",
		ui: {
			select: async (_header, options) => {
				seenOptions.push(options);
				return select ? select(options) : undefined;
			},
			editor: async () => editor,
			notify: (m) => notifications.push(String(m)),
			setStatus: (k, v) => statuses.push([k, v]),
		},
	};
	return { ctx, notifications, statuses, seenOptions };
}

const counters = () => ({
	approved: state.approvedCount,
	blocked: state.blockedCount,
	edited: state.editedCount,
});

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "decision-gate-"));
	state.config = { ...DEFAULT_CONFIG, useJev: false };
	state.approvedCount = 0;
	state.blockedCount = 0;
	state.editedCount = 0;
	state.sessionExemptions = new Set();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ pass-through */

test("a disabled gate never inspects the call", async () => {
	state.config.enabled = false;
	const { ctx, statuses, seenOptions } = makeCtx({ hasUI: true });

	assert.equal(await handleToolCallGate(DESTRUCTIVE(), ctx), undefined);
	assert.deepEqual(counters(), { approved: 0, blocked: 0, edited: 0 });
	assert.equal(seenOptions.length, 0, "must not prompt");
	assert.equal(statuses.length, 0, "must not touch the statusline");
	assert.deepEqual(logRecords(), [], "must not write an audit record");
});

test("mode 'off' never inspects the call", async () => {
	state.config.mode = "off";
	const { ctx, seenOptions } = makeCtx({ hasUI: true });

	assert.equal(await handleToolCallGate(DESTRUCTIVE(), ctx), undefined);
	assert.deepEqual(counters(), { approved: 0, blocked: 0, edited: 0 });
	assert.equal(seenOptions.length, 0);
});

test("tools listed in exemptTools are never gated", async () => {
	state.config.exemptTools = ["read"];
	const { ctx, seenOptions } = makeCtx({ hasUI: true });

	assert.equal(await handleToolCallGate(EXEMPT(), ctx), undefined);
	assert.deepEqual(counters(), { approved: 0, blocked: 0, edited: 0 });
	assert.equal(seenOptions.length, 0);
});

test("session exemptions skip the gate even for destructive calls", async () => {
	state.sessionExemptions.add("bash");
	const { ctx, seenOptions } = makeCtx({ hasUI: true });

	assert.equal(await handleToolCallGate(DESTRUCTIVE(), ctx), undefined);
	assert.deepEqual(counters(), { approved: 0, blocked: 0, edited: 0 });
	assert.equal(seenOptions.length, 0);
});

/* --------------------------------------------------------------- approval decision */

test("mode 'always' without a UI auto-approves and records it in the audit log", async () => {
	// FIXED: the headless branch used to bump the counter and return without logging,
	// so approvals granted without a UI were invisible in the audit trail. It now
	// records them as `auto_approved`, like the other automatic approvals.
	const { ctx, seenOptions } = makeCtx();

	assert.equal(await handleToolCallGate(SAFE(), ctx), undefined);
	assert.equal(counters().approved, 1);
	assert.equal(seenOptions.length, 0, "no prompt without a UI");
	const records = logRecords();
	assert.equal(records.length, 1, "headless approval IS logged");
	assert.equal(records[0].verdict, "auto_approved");
	assert.equal(records[0].tool, "bash");
});

test("an auto-approved call with a UI present is logged as auto_approved", async () => {
	state.config.mode = "risky";
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	assert.equal(await handleToolCallGate(SAFE(), ctx), undefined);
	assert.equal(seenOptions.length, 0, "a safe call in risky mode needs no prompt");
	assert.deepEqual(
		logRecords().map((r) => r.verdict),
		["auto_approved"],
	);
});

test("mode 'risky' auto-approves a safe call", async () => {
	state.config.mode = "risky";
	const { ctx } = makeCtx();

	assert.equal(await handleToolCallGate(SAFE(), ctx), undefined);
	assert.equal(counters().approved, 1);
	assert.equal(logRecords()[0].verdict, "auto_approved");
});

test("mode 'risky' treats a destructive call as needing approval", async () => {
	state.config.mode = "risky";
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	assert.equal(await handleToolCallGate(DESTRUCTIVE(), ctx), undefined);
	assert.equal(seenOptions.length, 1, "a destructive call must prompt");
	assert.equal(counters().approved, 1);
});

test("mode 'risky' compares against the threshold inclusively", async () => {
	// Safe input scores irreversibleProb 0.1; threshold 0.1 must therefore prompt.
	state.config.mode = "risky";
	state.config.threshold = 0.1;
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(SAFE(), ctx);
	assert.equal(seenOptions.length, 1, "risk == threshold must count as needing approval");
});

test("mode 'destructive' auto-approves a safe call but prompts for a destructive one", async () => {
	state.config.mode = "destructive";

	const safe = makeCtx({ hasUI: true, select: () => "Schválit" });
	await handleToolCallGate(SAFE(), safe.ctx);
	assert.equal(safe.seenOptions.length, 0, "a safe call must not prompt");
	assert.equal(counters().approved, 1);

	const destructive = makeCtx({ hasUI: true, select: () => "Schválit" });
	await handleToolCallGate(DESTRUCTIVE(), destructive.ctx);
	assert.equal(destructive.seenOptions.length, 1);
	assert.equal(counters().approved, 2);
});

test("a sensitive payload is treated as destructive and never reaches the network", async () => {
	state.config.mode = "destructive";
	state.config.useJev = true; // still offline: sensitive payloads short-circuit to the fallback
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(SENSITIVE(), ctx);
	assert.equal(seenOptions.length, 1, "a sensitive payload must prompt in destructive mode");
});

test("without a UI, a call needing approval is still approved", async () => {
	state.config.mode = "always";
	const { ctx, seenOptions } = makeCtx();

	assert.equal(await handleToolCallGate(DESTRUCTIVE(), ctx), undefined);
	assert.equal(seenOptions.length, 0);
	assert.equal(counters().approved, 1, "headless mode approves rather than blocking");
});

/* ------------------------------------------------------------------- dialog choices */

test("approving allows the call", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => "Schválit" });

	assert.equal(await handleToolCallGate(SAFE(), ctx), undefined);
	assert.equal(counters().approved, 1);
	assert.equal(logRecords()[0].verdict, "approved");
});

test("the dialog offers the exemption and edit options", async () => {
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(SAFE(), ctx);
	const options = seenOptions[0];
	for (const expected of ["Schválit", "Upravit argumenty", "Odmítnout"]) {
		assert.ok(options.includes(expected), `expected option ${expected} in ${JSON.stringify(options)}`);
	}
	assert.ok(
		options.some((o) => o.startsWith("Osvobodit 'bash' pro toto sezení")),
		"expected the session exemption option",
	);
});

test("allowEdit=false removes the edit option from the dialog", async () => {
	state.config.allowEdit = false;
	const { ctx, seenOptions } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(SAFE(), ctx);
	assert.equal(seenOptions[0].includes("Upravit argumenty"), false);
});

test("rejecting blocks the call and records the verdict", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => "Odmítnout" });

	const result = await handleToolCallGate(SAFE(), ctx);
	assert.equal(result?.block, true);
	assert.match(result.reason, /byla zamítnuta uživatelem/);
	assert.match(result.reason, /openrouter\/test-model/, "the reason names the active model");
	assert.deepEqual(counters(), { approved: 0, blocked: 1, edited: 0 });
	assert.equal(logRecords()[0].verdict, "rejected");
});

test("dismissing the dialog (undefined choice) counts as a rejection", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => undefined });

	const result = await handleToolCallGate(SAFE(), ctx);
	assert.equal(result?.block, true);
	assert.equal(counters().blocked, 1);
});

test("choosing the exemption option approves and exempts the tool for the session", async () => {
	const { ctx, notifications } = makeCtx({
		hasUI: true,
		select: () => "Osvobodit 'bash' pro toto sezení",
	});

	assert.equal(await handleToolCallGate(SAFE(), ctx), undefined);
	assert.equal(state.sessionExemptions.has("bash"), true);
	assert.equal(counters().approved, 1);
	assert.ok(notifications.some((n) => /osvobozen/.test(n)));
	assert.equal(logRecords()[0].verdict, "approved");
});

test("editing the arguments replaces the input in place and approves", async () => {
	const event = SAFE();
	const { ctx, notifications } = makeCtx({
		hasUI: true,
		select: () => "Upravit argumenty",
		editor: '{"command":"ls -la --color"}',
	});

	assert.equal(await handleToolCallGate(event, ctx), undefined);
	assert.deepEqual(event.input, { command: "ls -la --color" }, "input is mutated in place");
	assert.equal(counters().approved, 1);
	assert.equal(counters().edited, 1);
	assert.equal(logRecords()[0].verdict, "edited");
	assert.ok(notifications.some((n) => /upraveny a schváleny/.test(n)));
});

test("invalid edited JSON blocks the call", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => "Upravit argumenty", editor: "{not json" });

	const result = await handleToolCallGate(SAFE(), ctx);
	assert.equal(result?.block, true);
	assert.match(result.reason, /neplatný JSON/);
	assert.deepEqual(counters(), { approved: 0, blocked: 1, edited: 0 });
});

test("cancelling the editor blocks the call", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => "Upravit argumenty", editor: undefined });

	const result = await handleToolCallGate(SAFE(), ctx);
	assert.equal(result?.block, true);
	assert.match(result.reason, /stornována/);
	assert.equal(counters().blocked, 1);
});

/* ------------------------------------------------------------------------- audit log */

test("the audit log records the tool, model and assessment", async () => {
	const { ctx } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(DESTRUCTIVE(), ctx);
	const [record] = logRecords();
	assert.equal(record.tool, "bash");
	assert.deepEqual(record.model, { provider: "openrouter", id: "test-model", thinking: "medium" });
	assert.equal(record.assessment.riskCategory, "destructive");
	assert.equal(typeof record.timestamp, "string");
});

test("logDecisions=false suppresses the audit log", async () => {
	state.config.logDecisions = false;
	const { ctx } = makeCtx({ hasUI: true, select: () => "Schválit" });

	await handleToolCallGate(SAFE(), ctx);
	assert.equal(existsSync(logFile()), false);
	assert.equal(counters().approved, 1, "the decision itself still happens");
});
