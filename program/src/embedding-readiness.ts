/** Small operational canary, not a benchmark or accuracy certification. */
export const EMBEDDING_CANARY_INPUTS = [
  "Which animal purrs and chases mice?",
  "A cat purrs and hunts mice.",
  "A diesel engine powers a delivery truck.",
  "How do I bake a loaf of bread?",
  "Mix flour, yeast and water, let the dough rise, then bake it.",
  "A database index speeds up SQL queries.",
  "How many copies of the artist's debut album were released?",
  "The musician released only 500 copies of the first album.",
  "Schools use virtual reality for classroom instruction.",
] as const;

export function gradeEmbeddingReadiness(data: unknown, dimensions: number) {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows) || rows.length !== EMBEDDING_CANARY_INPUTS.length) return { ok: false, error: "invalid_embedding_response" };
  const vectors: number[][] = [];
  for (const row of rows) {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= rows.length || vectors[row.index]) return { ok: false, error: "invalid_embedding_indices" };
    if (!Array.isArray(row.embedding) || row.embedding.length !== dimensions || row.embedding.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) return { ok: false, error: "invalid_embedding_vector" };
    if (row.embedding.reduce((n: number, v: number) => n + v*v, 0) <= 0) return { ok: false, error: "invalid_embedding_vector" };
    vectors[row.index] = row.embedding;
  }
  const cosine = (a: number[], b: number[]) => a.reduce((n,v,i) => n + v*b[i]!,0) / Math.sqrt(a.reduce((n,v)=>n+v*v,0)*b.reduce((n,v)=>n+v*v,0));
  const checks = [0,3,6].map(i => {
    const relevant = cosine(vectors[i]!,vectors[i+1]!);
    const distractor = cosine(vectors[i]!,vectors[i+2]!);
    return { case: i/3+1, relevant, distractor, ok: relevant > distractor + 0.01 };
  });
  const ok = checks.every(check => check.ok);
  return { ok, checks, ...(!ok ? { error: "embedding_semantic_check_failed" } : {}) };
}
