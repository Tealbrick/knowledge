import { gbrainServiceExposure, hindsightExposure, hindsightMcpTools, hindsightOpenApi, hindsightOperationSpecs, portalCapabilityForScope,
  type EngineExposure, type HindsightOperationSpec } from "../src/engine-exposure.js";
import { hindsightBankForPartition } from "../src/hindsight-client.js";

/** Shared by the coverage tests and scripts/engine-coverage-report.ts. */
export interface EngineCoverage {
  readonly engine: string;
  readonly version: string;
  readonly upstream: number;
  readonly exposed: number;
  readonly read: number;
  readonly write: number;
  readonly excluded: number;
  /** Upstream operations neither exposed nor excluded (must be empty). */
  readonly unaccounted: readonly string[];
  /** Operations both exposed and excluded, or not upstream at all (must be empty). */
  readonly inconsistent: readonly string[];
}

export function engineCoverage(exposure: EngineExposure): EngineCoverage {
  const upstream = new Set(exposure.upstream);
  const exposed = [...exposure.exposed.values()];
  return {
    engine: exposure.engine, version: exposure.version, upstream: upstream.size, exposed: exposed.length,
    read: exposed.filter(op => op.scope === "read").length, write: exposed.filter(op => op.scope === "write").length,
    excluded: exposure.excluded.size,
    unaccounted: exposure.upstream.filter(name => !exposure.exposed.has(name) && !exposure.excluded.has(name)),
    inconsistent: [...new Set([...exposure.exposed.keys(), ...exposure.excluded.keys()])]
      .filter(name => !upstream.has(name) || (exposure.exposed.has(name) && exposure.excluded.has(name)) || !(exposure.excluded.get(name) ?? "x").trim()),
  };
}

export const engineExposures = () => [gbrainServiceExposure(), hindsightExposure()] as const;

function sampleValue(schema: unknown): unknown {
  const value = (schema ?? {}) as Record<string, unknown>;
  const variant = Array.isArray(value.anyOf) ? (value.anyOf as Record<string, unknown>[]).find(item => item.type !== "null") ?? {} : value;
  if (Array.isArray(variant.enum)) return variant.enum[0];
  switch (variant.type) {
    case "integer": case "number": return 1;
    case "boolean": return true;
    case "array": return [sampleValue(variant.items)];
    default: return "fixture";
  }
}

function deref(schema: unknown): Record<string, unknown> {
  const value = (schema ?? {}) as Record<string, unknown>;
  const ref = typeof value.$ref === "string" ? value.$ref.split("/").at(-1)! : null;
  return (ref ? hindsightOpenApi().components.schemas[ref] : value) as Record<string, unknown>;
}

/** Minimal well-formed arguments for one Hindsight operation in a partition (placeholders only). */
export function hindsightSampleArguments(spec: HindsightOperationSpec, partitionKey: string): Record<string, unknown> {
  const bank = hindsightBankForPartition(partitionKey);
  const args: Record<string, unknown> = {};
  for (const name of spec.pathParams) {
    args[name] = name === "chunk_id" ? `${bank}_fixture-doc_0` : name === "key" ? `banks/${bank}/exports/fixture.zip` : `fixture-${name.replace(/_/gu, "-")}`;
  }
  for (const query of spec.queryParams) if (query.required) args[query.name] = sampleValue(query.schema);
  if (spec.name === "import_bank_transfer") args.mode = "merge";
  if (spec.body === "json") args.body = {};
  if (spec.body === "multipart") {
    const file = { filename: "fixture.zip", contentBase64: Buffer.from("PK\u0003\u0004").toString("base64"), contentType: "application/zip" };
    const properties = (deref(spec.bodySchema).properties ?? {}) as Record<string, Record<string, unknown>>;
    args.body = Object.fromEntries(Object.entries(properties).map(([name, property]) => [name,
      property.type === "array" ? [file] : typeof property.contentMediaType === "string" ? file : "{}"]));
  }
  return args;
}

/** Machine-readable agent-path plan: every exposed op with its Portal capability and sample arguments. */
export function agentPathPlan(partitionKey: string) {
  const specs = hindsightOperationSpecs();
  const plan = (exposure: EngineExposure) => ({
    engine: exposure.engine, version: exposure.version, coverage: engineCoverage(exposure),
    exposed: [...exposure.exposed.values()].map(op => ({
      name: op.name, scope: op.scope, portalCapability: portalCapabilityForScope(op.scope), capabilities: op.capabilities, destructive: op.destructive,
      arguments: exposure.engine === "hindsight" ? hindsightSampleArguments(specs.get(op.name)!, partitionKey) : {},
      ...(exposure.engine === "hindsight" ? { http: { method: specs.get(op.name)!.method, path: specs.get(op.name)!.path, bankScoped: specs.get(op.name)!.bankScoped } } : {}),
    })),
    excluded: [...exposure.excluded].map(([name, reason]) => ({ name, reason })),
  });
  return { gbrain: plan(gbrainServiceExposure()), hindsight: plan(hindsightExposure()), bank: hindsightBankForPartition(partitionKey) };
}

export function markdownReport(): string {
  const lines: string[] = ["# Knowledge memory-engine coverage", "",
    "Every operation of each pinned upstream engine is either exposed to agents through the native memory route",
    "(`GET /api/brain/native/tools`, `POST /api/brain/native/<operation>`) with an explicit Portal capability, or excluded with a reason.", "",
    "| Engine | Pin | Upstream ops | Exposed (read / write) | Excluded | Accounted |", "|---|---|---:|---:|---:|---|"];
  for (const exposure of engineExposures()) {
    const c = engineCoverage(exposure);
    lines.push(`| ${c.engine} | ${c.version} | ${c.upstream} | ${c.exposed} (${c.read} / ${c.write}) | ${c.excluded} | ${c.unaccounted.length || c.inconsistent.length ? `NO: ${[...c.unaccounted, ...c.inconsistent].join(", ")}` : "100%"} |`);
  }
  for (const exposure of engineExposures()) {
    lines.push("", `## ${exposure.engine} ${exposure.version}`, "", `Provenance: ${Object.entries(exposure.provenance).map(([key, value]) => `${key} \`${value}\``).join("; ")}`, "",
      "### Exposed", "", "| Operation | Scope | Portal capability | CRUD-derived Program capabilities |", "|---|---|---|---|");
    for (const op of exposure.exposed.values()) lines.push(`| \`${op.name}\` | ${op.scope}${op.destructive ? " (destructive)" : ""} | \`${portalCapabilityForScope(op.scope)}\` | ${op.capabilities.map(cap => `\`${cap}\``).join(" + ")} |`);
    lines.push("", "### Excluded", "", "| Operation | Reason |", "|---|---|");
    for (const [name, reason] of exposure.excluded) lines.push(`| \`${name}\` | ${reason} |`);
  }
  lines.push("", "## Hindsight MCP tools (upstream MCP server, disabled in the template)", "", "| MCP tool | HTTP operation | Knowledge |", "|---|---|---|");
  const hindsight = hindsightExposure();
  for (const tool of hindsightMcpTools()) {
    lines.push(`| \`${tool.name}\` | \`${tool.operationId}\` | ${hindsight.exposed.has(tool.operationId) ? `exposed (${hindsight.exposed.get(tool.operationId)!.scope})` : `excluded: ${hindsight.excluded.get(tool.operationId)}`} |`);
  }
  lines.push("", "Note: the embedded managed GBrain worker (vendored v0.48.2, default topology) keeps its fixed native-memory v1 contract of 21 operations;",
    "the full surface above applies to the pinned GBrain service topology (`KNOWLEDGE_GBRAIN_URL`).", "");
  return lines.join("\n");
}
