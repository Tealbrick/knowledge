/**
 * Contract variable names (`tealbrick.app.json` runtime.*Env) and the Knowledge names the Program has always
 * read. A Portal-provisioned deployment may set either spelling; the Program code reads the Knowledge name and
 * the contract kit reads the contract name, so both are filled from whichever one is set.
 *
 * Both set to different values is a configuration error and stops startup (the message names variables only).
 */
export const ENV_ALIASES: readonly (readonly [contract: string, knowledge: string])[] = Object.freeze([
  ["TEALBRICK_INSTANCE_TOKEN", "KNOWLEDGE_INSTANCE_TOKEN"],
  ["TEALBRICK_TENANT_ID", "KNOWLEDGE_COMPANY_ID"],
  ["TEALBRICK_PORTAL_ORG_ID", "KNOWLEDGE_PORTAL_ORG_ID"],
  ["TEALBRICK_SERVICE_PRINCIPALS", "KNOWLEDGE_SERVICE_PRINCIPALS"],
]);

export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [contract, knowledge] of ENV_ALIASES) {
    const a = env[contract];
    const b = env[knowledge];
    if (a !== undefined && b !== undefined && a !== b) {
      throw new Error(`${contract} and ${knowledge} are both set to different values; set only one`);
    }
    const value = a ?? b;
    if (value !== undefined) {
      env[contract] = value;
      env[knowledge] = value;
    }
  }
}
