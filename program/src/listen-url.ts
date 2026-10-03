import type { AddressInfo } from "node:net";

function hostForLocalUrl(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}

export function describeListenUrl(address: AddressInfo | string | null): {
  readonly baseUrl?: string;
  readonly host?: string;
  readonly port?: number;
} {
  if (address === null || typeof address === "string") {
    return {};
  }
  const host = hostForLocalUrl(address.address);
  return {
    baseUrl: `http://${host}:${address.port}`,
    host: address.address,
    port: address.port,
  };
}
