export interface FakeHindsightCall {
  readonly method: string; readonly path: string; readonly rawPath: string; readonly query: Record<string, string>;
  readonly bank: string | null; readonly contentType: string | null; readonly body: unknown;
}
export interface FakeGBrainCall { readonly name: string; readonly args: Record<string, unknown>; readonly source: string; readonly scopes: string }
export function startFakeHindsight(options: { apiKey: string; version?: string }): Promise<{ baseUrl: string; calls: FakeHindsightCall[]; close(): Promise<void> }>;
export function startFakeGBrainService(options: { adminToken: string; tools: readonly string[]; version?: string }): Promise<{ baseUrl: string; calls: FakeGBrainCall[]; close(): Promise<void> }>;
