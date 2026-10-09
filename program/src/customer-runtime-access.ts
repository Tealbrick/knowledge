/** Narrow direct-runtime surface. Authorization and object scope remain Program-owned. */
export function customerRuntimeRoute(method: string, rawUrl: string): boolean {
  // Do not normalize an absolute URL, encoded separator or traversal into an admitted route.
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return false;
  const pathname = rawUrl.split("?", 1)[0]!;
  if (/%(?:2f|5c|2e)|\\|(?:^|\/)\.{1,2}(?:\/|$)/iu.test(pathname)) return false;
  const verb = method.toUpperCase();
  const segment = "[A-Za-z0-9_.:-]+";
  if (pathname === "/api/brain/native/tools") return verb === "GET";
  if (/^\/api\/brain\/native\/[a-z][a-z_]*$/u.test(pathname)) return verb === "POST";
  if (pathname === "/api/knowledge/partitions") return verb === "GET";
  if (new RegExp(`^/api/companies/${segment}/knowledge/collections$`, "u").test(pathname)) return ["GET", "POST"].includes(verb);
  if (new RegExp(`^/api/companies/${segment}/knowledge/search$`, "u").test(pathname)) return verb === "GET";
  if (new RegExp(`^/api/knowledge/collections/${segment}$`, "u").test(pathname)) return ["GET", "DELETE"].includes(verb);
  if (new RegExp(`^/api/knowledge/collections/${segment}/tree$`, "u").test(pathname)) return verb === "GET";
  if (new RegExp(`^/api/knowledge/collections/${segment}/documents$`, "u").test(pathname)) return verb === "POST";
  if (new RegExp(`^/api/knowledge/documents/${segment}$`, "u").test(pathname)) return ["GET", "PATCH", "DELETE"].includes(verb);
  if (new RegExp(`^/api/knowledge/documents/${segment}/revisions$`, "u").test(pathname)) return verb === "GET";
  if (pathname === "/api/research/engine/notebooks") return verb === "GET";
  // Mapped Research retains its separate read/write principal and durable receipt contract.
  if (new RegExp(`^/api/research/notebooks/${segment}/engine(?:/[^?#]*)?$`, "u").test(pathname)) return ["GET", "POST"].includes(verb);
  if (["/api/brain/context", "/api/brain/recall", "/api/brain/extract-facts"].includes(pathname)) return verb === "POST";
  return ["/api/brain/entities", "/api/brain/indexing"].includes(pathname) && verb === "GET";
}
