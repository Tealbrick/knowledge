import type { GBrainRuntime } from "./gbrain.js";

/**
 * The memory-engine boundary: exactly the GBrainRuntime surface the Program
 * calls today. A second engine (Hindsight) implements this contract behind the
 * unchanged Knowledge edge, partition authorization and capability checks;
 * operations an engine cannot honour must fail explicitly, never degrade into
 * another engine's semantics.
 */
export type MemoryEngine = Pick<GBrainRuntime,
  | "start" | "close" | "status" | "nativeCapabilityReadiness"
  | "recall" | "query" | "extractFacts" | "nativeOperation"
  | "projectDocument" | "projectResearchSource" | "deleteProjection"
  | "listPages" | "getPage" | "getLinks" | "getTimeline" | "getEntityCard" | "traverseGraph">;

export const MEMORY_ENGINES = ["gbrain", "hindsight"] as const;
export type MemoryEngineKind = (typeof MEMORY_ENGINES)[number];

/** KNOWLEDGE_MEMORY_ENGINE; absent means GBrain. Unknown values fail startup. */
export function memoryEngineKind(value: string | undefined): MemoryEngineKind {
  const engine = value?.trim() || "gbrain";
  if (!(MEMORY_ENGINES as readonly string[]).includes(engine)) throw new Error("KNOWLEDGE_MEMORY_ENGINE must be gbrain or hindsight");
  return engine as MemoryEngineKind;
}

/** Compile-time proof that the current runtime satisfies the boundary. */
export const gbrainSatisfiesMemoryEngine = (runtime: GBrainRuntime): MemoryEngine => runtime;
