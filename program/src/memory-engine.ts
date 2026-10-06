import { GBrainRuntime } from "./gbrain.js";
import type { NativeOperationPolicy } from "./engine-exposure.js";
import { HindsightMemoryEngine } from "./hindsight-engine.js";
import { memoryEngineKind, type MemoryEngineKind } from "./memory-engine-kind.js";
import type { KnowledgeConfig } from "./types.js";

type GBrainStatus = ReturnType<GBrainRuntime["status"]>;

export { MEMORY_ENGINES, memoryEngineKind, type MemoryEngineKind } from "./memory-engine-kind.js";

export type MemoryEngineStatus = Omit<GBrainStatus, "runtime" | "topology"> & {
  readonly runtime: MemoryEngineKind;
  readonly topology: GBrainStatus["topology"] | "hindsight-service";
};

/**
 * The memory-engine boundary: the GBrainRuntime surface the Program calls,
 * plus the per-operation policy of the engine's native (agent) surface. A
 * second engine (Hindsight) implements this contract behind the unchanged
 * Knowledge edge, partition authorization and capability checks; operations
 * an engine cannot honour fail explicitly (`engine_capability_unavailable`),
 * never degrade into another engine's semantics.
 */
export interface MemoryEngine {
  readonly engine: MemoryEngineKind;
  start: GBrainRuntime["start"];
  close: GBrainRuntime["close"];
  status(): MemoryEngineStatus;
  nativeCapabilityReadiness: GBrainRuntime["nativeCapabilityReadiness"];
  recall: GBrainRuntime["recall"];
  query: GBrainRuntime["query"];
  extractFacts: GBrainRuntime["extractFacts"];
  /** `catalog` or an operation for which nativeOperationPolicy() is non-null. */
  nativeOperation: GBrainRuntime["nativeOperation"];
  /** Scope and capabilities of an agent-callable native operation; null when not exposed. */
  nativeOperationPolicy(name: string): NativeOperationPolicy | null;
  projectDocument: GBrainRuntime["projectDocument"];
  projectResearchSource: GBrainRuntime["projectResearchSource"];
  deleteProjection: GBrainRuntime["deleteProjection"];
  listPages: GBrainRuntime["listPages"];
  listEntities: GBrainRuntime["listEntities"];
  getPage: GBrainRuntime["getPage"];
  getLinks: GBrainRuntime["getLinks"];
  getTimeline: GBrainRuntime["getTimeline"];
  getEntityCard: GBrainRuntime["getEntityCard"];
  traverseGraph: GBrainRuntime["traverseGraph"];
}

/** One engine per deployment, selected by configuration; GBrain when unset (existing deployments unchanged). */
export function createMemoryEngine(config: KnowledgeConfig): MemoryEngine {
  return memoryEngineKind(config.memoryEngine) === "hindsight" ? new HindsightMemoryEngine(config) : new GBrainRuntime(config);
}

/** Compile-time proof that the runtimes satisfy the boundary. */
export const gbrainSatisfiesMemoryEngine = (runtime: GBrainRuntime): MemoryEngine => runtime;
export const hindsightSatisfiesMemoryEngine = (runtime: HindsightMemoryEngine): MemoryEngine => runtime;
