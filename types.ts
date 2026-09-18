// types.ts — typové definice pro pi-decision-gate

export type ApprovalMode = "always" | "risky" | "destructive" | "off";

export interface DecisionGateConfig {
  /** Hlavní vypínač brány */
  enabled: boolean;
  /**
   * Režim schvalování:
   * - always: schvalovat každé neosvobozené volání nástroje
   * - risky: schvalovat na základě Jev hodnocení rizika (skóre >= threshold)
   * - destructive: schvalovat pouze destruktivní akce (rm, git reset, drop...)
   * - off: brána je neaktivní
   */
  mode: ApprovalMode;
  /** Práh rizika pro Jev model (0.0 - 1.0, výchozí 0.7) */
  threshold: number;
  /** Zda používat Jev model přes OpenRouter pro sémantické posuzování akcí */
  useJev: boolean;
  /** Identifikátor modelu Jev na OpenRouteru */
  jevModel: string;
  /** Nástroje osvobozené od schvalování (např. ["read"]) */
  exemptTools: string[];
  /** Povolit úpravu parametrů nástroje před schválením */
  allowEdit: boolean;
  /** Zda logovat rozhodnutí do .pi/decision-gate/decisions.jsonl */
  logDecisions: boolean;
}

export interface JevAssessment {
  riskScore: number;
  riskCategory: "safe" | "moderate" | "destructive";
  irreversibleProb: number;
  offTaskProb: number;
  confidence: number;
  consequenceScore?: number; // 0 - 3 (blast radius)
  taskFamily?: string; // routine-transformation, investigation, mutation, cleanup
  recommendedEffort?: "low" | "medium" | "high";
  isolatePaneScore?: number; // 0 - 3 (vhodnost pro oddělené okno/sub-pane)
  shouldOffloadToPane?: boolean; // Zda je doporučeno delegovat do nového okna
  offloadReason?: string;
  costUsd: number;
  costCzk?: number;
  modelUsed: string;
  sanitized?: boolean; // Zda byl payload z bezpečnostních důvodů vyhodnocen lokálně
}

export interface HerdrPaneRecommendation {
  suitable: boolean;
  reason: string;
  recommendedModel: string;
  recommendedEffort: "low" | "medium" | "high";
  agentKind: "pi" | "claude" | "cursor" | "codex" | "opencode";
}

export interface DecisionRecord {
  id: string;
  timestamp: string;
  model: {
    provider?: string;
    id?: string;
    thinking?: string;
  };
  tool: string;
  input: unknown;
  verdict: "approved" | "edited" | "rejected" | "auto_approved" | "delegated_to_pane";
  assessment?: JevAssessment;
}

export interface BalanceInfo {
  remaining: number;
  usage: number;
}

export interface ModelUsageStat {
  modelKey: string;
  provider: string;
  id: string;
  turns: number;
  lastUsed: number;
  source: "session" | "config" | "active";
}

export interface ModelSuitability {
  modelKey: string;
  provider: string;
  id: string;
  score: number;
  reason: string;
  turns: number;
  source: string;
  cachePenalty?: boolean;
  cacheNotice?: string;
}

export interface ThinkingRecommendation {
  recommendedLevel: "low" | "medium" | "high";
  reason: string;
  canOptimize: boolean;
}

export interface DecisionGateState {
  config: DecisionGateConfig;
  sessionCostUsd: number;
  approvedCount: number;
  blockedCount: number;
  editedCount: number;
  sessionExemptions: Set<string>;
}
