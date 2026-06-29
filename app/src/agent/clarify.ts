import type { NodeId } from "../shared/types.js";
import type { DesignSystemProfile } from "../shared/design-system.js";
import { assessClarification, type Usage } from "./llm-adapter.js";

export interface ClarificationRequest {
  original: string;
  questions: string[];
  assumptions: string[];
}

/**
 * Decide whether to ask the human clarifying questions before building — now LLM-driven
 * (was a brittle regex gate). One cheap, low-effort forced tool-call judges ambiguity
 * (see assessClarification in llm-adapter), so the model, not a fixed keyword list,
 * chooses when a generative request is under-specified enough to interrupt for.
 *
 * Returns null to build immediately. Resilient by design: an empty/whitespace intent
 * short-circuits without a call, and any model/transport failure resolves to null so a
 * flake never blocks the run — we just proceed to plan().
 */
export async function maybeClarifyDesignIntent(
  intent: string,
  selection: NodeId[] = [],
  opts: { onUsage?: (u: Usage) => void; designSystem?: DesignSystemProfile | null } = {},
): Promise<ClarificationRequest | null> {
  const text = intent.trim();
  if (!text) return null;
  try {
    const assessed = await assessClarification(
      text,
      selection,
      opts.onUsage,
      opts.designSystem ?? null,
    );
    if (!assessed) return null;
    return { original: text, questions: assessed.questions, assumptions: assessed.assumptions };
  } catch {
    // Clarification is a best-effort nicety; never let it strand a valid prompt.
    return null;
  }
}

export function formatClarifiedIntent(original: string, answers: string): string {
  const cleanedAnswers = answers.trim();
  if (!cleanedAnswers) return original;
  return (
    `${original}\n\n` +
    `Clarifying answers and constraints:\n` +
    `${cleanedAnswers}\n\n` +
    `Use these answers as requirements for the design.`
  );
}
