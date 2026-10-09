import { describe, expect, it } from "vitest";

import type { KnowledgeStorePersistence, KnowledgeStoreSnapshot } from "./store.js";
import { KnowledgeStore } from "./store.js";

class MemoryPersistence implements KnowledgeStorePersistence {
  saved: KnowledgeStoreSnapshot | null = null;

  constructor(private readonly snapshot: KnowledgeStoreSnapshot) {}

  load(): KnowledgeStoreSnapshot | null {
    return this.snapshot;
  }

  save(snapshot: KnowledgeStoreSnapshot): void {
    this.saved = snapshot;
  }
}

describe("KnowledgeStore snapshot migration", () => {
  it("restores v1 snapshots that predate Research fields with default counters and arrays", () => {
    const oldSnapshot = {
      version: 1,
      counters: {
        bindingCounter: 1,
        collectionCounter: 1,
        documentCounter: 1,
        revisionCounter: 1,
        commentCounter: 0,
        grantCounter: 0,
        attachmentCounter: 0,
        linkCounter: 0,
      },
      bindings: [],
      collections: [],
      documents: [],
      revisions: [],
      comments: [],
      accessPolicies: [],
      attachments: [],
      links: [],
    } as unknown as KnowledgeStoreSnapshot;
    const persistence = new MemoryPersistence(oldSnapshot);

    const store = new KnowledgeStore(persistence);
    const notebook = store.createResearchNotebook({
      companyId: "company-upgrade",
      title: "Upgrade research",
    });
    const source = store.createResearchSource({
      companyId: "company-upgrade",
      notebookId: notebook.id,
      title: "Upgrade source",
    });
    const output = store.createResearchOutput({
      companyId: "company-upgrade",
      notebookId: notebook.id,
      title: "Upgrade output",
    });

    expect(notebook.id).toBe("notebook_0001");
    expect(source?.id).toBe("source_0001");
    expect(output?.id).toBe("output_0001");
    expect(persistence.saved).toMatchObject({
      ownerBindings: [],
      notebooks: [expect.objectContaining({ id: "notebook_0001" })],
      sources: [expect.objectContaining({ id: "source_0001" })],
      outputs: [expect.objectContaining({ id: "output_0001" })],
    });
  });
});

describe("KnowledgeStore rollback from 0.5.0 random ids", () => {
  const collection = (id: string) => ({
    id,
    companyId: "company-rollback",
    name: id,
    description: null,
    sourceConfig: { type: "manual" },
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  });

  it("ignores random ids and an unsafe stored counter, so new ids stay unique", () => {
    const snapshot = {
      version: 1,
      counters: {
        bindingCounter: 0,
        // A counter saved by an unpatched 0.4.x after reading a random id as base 36.
        collectionCounter: 1.0546823587163712e31,
        documentCounter: 0,
        revisionCounter: 0,
        commentCounter: 0,
        grantCounter: 0,
        attachmentCounter: 0,
        linkCounter: 0,
      },
      bindings: [],
      collections: [collection("kcol_0001"), collection("kcol_0002"), collection("kcol_rx453x5ubnucrpthitha")],
      documents: [],
      revisions: [],
      comments: [],
      accessPolicies: [],
      attachments: [],
      links: [],
    } as unknown as KnowledgeStoreSnapshot;
    const store = new KnowledgeStore(new MemoryPersistence(snapshot));

    const first = store.createKnowledgeCollection("company-rollback", { name: "After rollback 1" });
    const second = store.createKnowledgeCollection("company-rollback", { name: "After rollback 2" });

    expect(first.id).toBe("kcol_0003");
    expect(second.id).toBe("kcol_0004");
    expect(new Set(store.listKnowledgeCollections("company-rollback", false).map((item) => item.id)).size).toBe(5);
  });
});
