import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  api,
  getSessionEnded,
  isSessionEndedResponse,
  resetSessionEndedForTests,
  subscribeSessionEnded,
} from "./api";
import { researchRequest } from "./research-chat-api";
import { SessionEndedBanner, SessionEndedSplash } from "./SessionNotice";

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionEndedForTests();
});

const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));

describe("Portal session ended mid-use", () => {
  it("classifies only edge session codes on 401 as a relaunch condition", () => {
    expect(isSessionEndedResponse(401, { error: "browser_session_required" })).toBe(true);
    expect(isSessionEndedResponse(401, { ok: false, error: "instance_auth_required" })).toBe(true);
    expect(isSessionEndedResponse(401, { ok: false, error: "request_denied" })).toBe(true);
    // Research sign-in, partition authorization and forbidden responses are not a Portal session loss.
    expect(isSessionEndedResponse(401, { error: "browser_session_invalid" })).toBe(false);
    expect(isSessionEndedResponse(401, { ok: false, error: "authentication_required" })).toBe(false);
    expect(isSessionEndedResponse(403, { error: "browser_session_required" })).toBe(false);
    expect(isSessionEndedResponse(401, "browser_session_required")).toBe(false);
  });

  it("notifies subscribers once when an API call reports an expired session", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionEnded(listener);
    respond(401, { error: "browser_session_required" });
    await expect(api("/api/knowledge/documents/a")).rejects.toMatchObject({ status: 401 });
    await expect(api("/api/knowledge/documents/b")).rejects.toMatchObject({ status: 401 });
    expect(getSessionEnded()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not raise the relaunch prompt for Research sign-in or authorization failures", async () => {
    respond(401, { ok: false, error: "authentication_required" });
    await expect(api("/api/brain/native/x")).rejects.toMatchObject({ status: 401 });
    respond(403, { ok: false, error: "settings_owner_required" });
    await expect(api("/api/settings/models")).rejects.toMatchObject({ status: 403 });
    respond(401, { error: "browser_session_invalid" });
    await expect(researchRequest("/api/research/browser-session")).rejects.toMatchObject({ status: 401 });
    expect(getSessionEnded()).toBe(false);
  });

  it("raises the relaunch prompt from Research transport when the Portal session is gone", async () => {
    respond(401, { error: "browser_session_required" });
    await expect(researchRequest("/api/research/engine/notebooks")).rejects.toMatchObject({ status: 401 });
    expect(getSessionEnded()).toBe(true);
  });

  it("renders relaunch guidance without internal codes", () => {
    for (const html of [
      renderToStaticMarkup(createElement(SessionEndedBanner, { onReload: () => undefined })),
      renderToStaticMarkup(createElement(SessionEndedSplash, { onReload: () => undefined })),
    ]) {
      expect(html).toContain("Your session ended");
      expect(html).toContain("Reopen Knowledge from Teal Brick Portal");
      expect(html).not.toMatch(/browser_session_required|instance_auth_required|401/);
    }
  });
});
