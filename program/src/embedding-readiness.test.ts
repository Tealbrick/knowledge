import { describe, it, expect } from "vitest";
import { gradeEmbeddingReadiness } from "./embedding-readiness.js";
describe("embedding semantic readiness", () => {
  const data = () => ({ data: Array.from({ length: 9 }, (_, index) => ({ index, embedding: index % 3 === 2 ? [0,1] : [1,0] })) });
  it("accepts correct relative relevance and respects response indices", () => {
    const value = data(); value.data.reverse();
    expect(gradeEmbeddingReadiness(value,2).ok).toBe(true);
  });
  it("rejects correctly sized but meaningless vectors", () => {
    const value=data(); value.data.forEach(row => { row.embedding=[1,0]; });
    expect(gradeEmbeddingReadiness(value,2)).toMatchObject({ok:false,error:"embedding_semantic_check_failed"});
  });
  it("rejects duplicate indices, zero vectors and non-finite components", () => {
    const duplicate=data(); duplicate.data[1]!.index=0;
    expect(gradeEmbeddingReadiness(duplicate,2).ok).toBe(false);
    for (const vector of [[0,0],[NaN,1],[Infinity,1]]) {
      const value=data(); value.data[0]!.embedding=vector;
      expect(gradeEmbeddingReadiness(value,2).ok).toBe(false);
    }
  });
});
