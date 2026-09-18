# ADR-006: ADR-005: cff6479 feat: adopt agent-router architecture with Jev pane i
- **Date:** 2026-09-18 15:35:52
- **Status:** active
- **Context:** ToolRenderContext<TState, Static<TParams>>) => Component;\n\n\t/ Custom rendering for tool result display /\n\trenderResult?: (\n\t\tresult: AgentToolResult<TDetails>,\n\t\toptions: ToolRenderResultOp
- **Decision:** /\n\texecute(\n\t\ttoolCallId: string,\n\t\tparams: Static<TParams>,\n\t\tsignal: AbortSignal | undefined,\n\t\tonUpdate: AgentToolUpdateCallback<TDetails> | undefined,\n\t\tctx: ExtensionContext,\n\t
- **Consequences:** Maintain this implementation to prevent regressions across environments.
