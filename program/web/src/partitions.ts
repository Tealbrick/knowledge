import { api } from "./api";

/** Owner-only listing from GET /api/companies/{companyId}/knowledge/partitions. */
export interface KnowledgePartitionListing {
  companyId: string;
  defaultPartitionKey: string;
  partitions: Array<{ key: string; partitionKey: string }>;
}

export interface PartitionOption {
  value: string;
  label: string;
}

export const DEFAULT_PARTITION_LABEL = "Workspace (default)";

export const getPartitions = (companyId: string) =>
  api<KnowledgePartitionListing>(`/api/companies/${encodeURIComponent(companyId)}/knowledge/partitions`);

/**
 * The Memory view's partition: always explicit (the workspace itself, or the
 * selected `workspace/key`). An omitted partition could span every partition
 * in a local GBrain, mixing edge partitions into the workspace view.
 */
export function brainPartitionFor(companyId: string): string {
  return companyId.trim();
}

/** The edge-partition key of a scope (`workspace/key`), or null for the workspace default. */
export function partitionKeyOf(defaultCompanyId: string, companyId: string): string | null {
  const base = defaultCompanyId.trim().toLowerCase();
  const scope = companyId.trim().toLowerCase();
  if (!base || !scope.startsWith(`${base}/`)) return null;
  const key = scope.slice(base.length + 1);
  return /^[a-z][a-z0-9-]{0,39}$/u.test(key) && key !== "default" ? key : null;
}

/**
 * Selector options: the workspace default first, then each edge partition by
 * key. The current scope is kept even when the listing does not (yet) show it.
 */
export function partitionOptions(defaultCompanyId: string, listing: KnowledgePartitionListing | undefined, current: string): PartitionOption[] {
  const options: PartitionOption[] = [{ value: defaultCompanyId, label: DEFAULT_PARTITION_LABEL }];
  const seen = new Set([defaultCompanyId]);
  const add = (value: string, key: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: key });
  };
  for (const partition of listing?.partitions ?? []) {
    if (partitionKeyOf(defaultCompanyId, partition.partitionKey) === partition.key) add(partition.partitionKey, partition.key);
  }
  const currentKey = partitionKeyOf(defaultCompanyId, current);
  if (currentKey) add(current, currentKey);
  return options;
}
