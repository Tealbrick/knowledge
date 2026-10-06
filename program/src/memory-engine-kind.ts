export const MEMORY_ENGINES = ["gbrain", "hindsight"] as const;
export type MemoryEngineKind = (typeof MEMORY_ENGINES)[number];

/** KNOWLEDGE_MEMORY_ENGINE; absent means GBrain. Unknown values fail startup. */
export function memoryEngineKind(value: string | null | undefined): MemoryEngineKind {
  const engine = value?.trim() || "gbrain";
  if (!(MEMORY_ENGINES as readonly string[]).includes(engine)) throw new Error("KNOWLEDGE_MEMORY_ENGINE must be gbrain or hindsight");
  return engine as MemoryEngineKind;
}
