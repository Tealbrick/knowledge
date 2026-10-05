/**
 * Customer-facing wording for machine error codes returned by Knowledge and
 * its instance edge. Codes stay available on ApiError.code for logic; people
 * see these sentences instead of raw identifiers.
 */
const MESSAGES: Record<string, string> = {
  // Session and access
  browser_session_required: "Your session ended. Reopen Knowledge from Teal Brick Portal to continue.",
  instance_auth_required: "Your session ended. Reopen Knowledge from Teal Brick Portal to continue.",
  request_denied: "Knowledge refused that request. Try again, or reopen Knowledge from Teal Brick Portal if it keeps happening.",
  request_too_large: "That is too large to upload.",
  authentication_required: "Sign in again to continue.",
  runtime_route_denied: "This credential is not allowed to do that.",
  forbidden: "You don't have permission to do that.",
  // Model settings
  invalid_model_settings: "Some model settings are missing or invalid. Check each URL, model name and key, then try again.",
  settings_owner_required: "Only the owner of this Knowledge installation can change model settings. Open Knowledge from Teal Brick Portal as its owner.",
  settings_origin_denied: "This change came from an unexpected page. Reload Knowledge and try again.",
  settings_update_in_progress: "Another settings change is still being checked. Wait a moment and try again.",
  settings_update_failed: "Model settings could not be saved. Your previous settings are unchanged.",
  brain_start_failed: "Your models passed their checks and were saved, but the memory engine did not start. Try saving again, or check the installation's logs.",
  embedding_migration_required: "Your existing memory uses a different embedding model or vector size. Keep the current embedding settings, or migrate memory before switching.",
  model_api_key_required: "Enter an API key. A saved key is only reused for the same provider and URL.",
  model_provider_conflict: "Models that use the same provider must share one URL and API key.",
  invalid_embedding_response: "The embedding model answered, but not in the expected format. Check the model name.",
  invalid_embedding_indices: "The embedding model answered, but not in the expected format. Check the model name.",
  invalid_embedding_vector: "The embedding model returned vectors of a different size. Check the embedding dimensions.",
  embedding_semantic_check_failed: "The embedding model did not pass a basic meaning check. Choose a text embedding model.",
  model_connection_failed: "Knowledge could not reach the model server. Check the URL and that the server is running.",
  invalid_model_response: "The model server answered, but not in the expected format. Check the model name.",
  provider_http_400: "The model provider rejected the request. Check the model name.",
  provider_http_401: "The model provider rejected the API key.",
  provider_http_403: "The model provider refused access with this API key.",
  provider_http_404: "The model provider does not recognise this URL or model name.",
  provider_http_429: "The model provider is rate-limiting this key. Try again later or check your plan.",
  // Documents, collections and service availability
  knowledge_unavailable: "Knowledge is restarting or unavailable. Try again shortly.",
  knowledge_web_asset_not_found: "Part of the app could not be loaded. Reload the page.",
  invalid_request: "Some of the information entered is invalid. Check it and try again.",
  knowledge_document_not_found: "That document no longer exists. Refresh to see the latest.",
  knowledge_collection_not_found: "That collection no longer exists. Refresh to see the latest.",
  knowledge_binding_not_found: "That link no longer exists. Refresh to see the latest.",
  knowledge_attachment_not_found: "That attachment no longer exists.",
  knowledge_link_not_found: "That document link no longer exists.",
  knowledge_link_target_not_found: "The linked document no longer exists.",
  knowledge_document_title_required: "Give the document a title.",
  knowledge_ingest_file_required: "Choose at least one file to import.",
  file_required: "Choose a file to upload.",
  partition_scope_denied: "This workspace is not available to you.",
  partition_key_required: "Choose a workspace first.",
  rules_denied: "Your organisation's approval rules don't allow this change.",
  rules_review_required: "This change needs approval before it can be made.",
  rules_unavailable: "The approval service is unavailable, so this change was not made. Try again shortly.",
  brain_write_forbidden: "This credential cannot write to memory.",
};

const STATUS_MESSAGES: Record<number, string> = {
  400: "Some of the information entered is invalid. Check it and try again.",
  401: "Sign in again to continue.",
  403: "You don't have permission to do that.",
  404: "That item no longer exists. Refresh to see the latest.",
  409: "This item changed since you opened it. Refresh and try again.",
  413: "That is too large to upload.",
  422: "Knowledge could not use those values. Check them and try again.",
  429: "Too many requests. Wait a moment and try again.",
  502: "A connected service did not respond. Try again shortly.",
  503: "A required service is unavailable right now. Try again shortly.",
};

const CODE = /^[a-z][a-z0-9_]{1,80}$/u;

export function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value) && value.includes("_");
}

/** Human sentence for a known code, else for the HTTP status. */
export function describeErrorCode(code: string | null | undefined, status = 0): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (code?.startsWith("provider_http_5")) return "The model provider had a server error. Try again later.";
  const generic = STATUS_MESSAGES[status] ?? (status >= 500 ? "Knowledge couldn't complete the request. Try again shortly." : "Knowledge couldn't complete the request.");
  return code && isErrorCode(code) ? `${generic} (Reference: ${code})` : generic;
}

/** Short heading for an error notice. */
export function errorTitle(status: number): string {
  if (status === 401) return "Sign-in required";
  if (status === 403) return "Not allowed";
  if (status === 404) return "Not found";
  if (status === 409) return "This changed";
  if (status === 503 || status === 502) return "Service unavailable";
  return "Something went wrong";
}
