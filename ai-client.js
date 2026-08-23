// ai-client.js -- the one place this CRM talks to Claude.
//
// hr.js grew two near-identical copies of this fetch: same endpoint, same
// headers, same structured-output shape, same refusal handling, same "no API
// key" fallback. Grant Finder would have been the third. This is that call,
// once.
//
// Deliberately raw fetch rather than the official SDK, to match what is
// already in the tree and to keep the production image at two runtime
// dependencies -- the Dockerfile installs --omit=dev, so anything added here
// ships. If the SDK is wanted later it can go behind this same function
// without touching a single caller.
//
// Two behaviours worth stating because callers depend on them:
//
//   1. NO KEY IS NOT AN ERROR. Without ANTHROPIC_API_KEY this returns
//      { ok: false, reason: "not_configured" } and the caller shows something
//      honest. An install without a key should degrade, not throw.
//   2. A REFUSAL IS NOT A CRASH. stop_reason "refusal" comes back as
//      { ok: false, reason: "refused" } with the model's own explanation.

"use strict";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Matches the existing HR screening default, and stays overridable per install.
const DEFAULT_MODEL = process.env.AI_MODEL || process.env.HR_AI_MODEL || "claude-opus-5";

function configured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// callClaude({ system, user, schema, effort, maxTokens, model })
//   -> { ok: true, text, parsed, model, usage }
//   -> { ok: false, reason, error }
//
// `schema` opts into structured output: the response is validated against it
// by the API and returned already parsed.
async function callClaude({
  system,
  user,
  schema = null,
  effort = "medium",
  maxTokens = 4096,
  model = DEFAULT_MODEL,
  timeoutMs = 120000,
} = {}) {
  if (!configured()) {
    return { ok: false, reason: "not_configured", error: "ANTHROPIC_API_KEY is not set." };
  }
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    output_config: { effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
    messages: [{ role: "user", content: user }],
  };

  // A hung request must not hold a staff member's browser open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "network", error: aborted ? "The request took too long." : e.message };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { ok: false, reason: "api_error", status: res.status, error: `Anthropic API ${res.status}: ${errText.slice(0, 300)}` };
  }

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, reason: "api_error", error: "The AI returned something unreadable." };

  if (data.stop_reason === "refusal") {
    const why = (data.stop_details && data.stop_details.explanation) || "";
    return { ok: false, reason: "refused", error: `The AI declined this request. ${why}`.trim() };
  }

  const textBlock = (data.content || []).find((b) => b.type === "text");
  const text = textBlock ? textBlock.text : "";
  if (!text) return { ok: false, reason: "empty", error: "The AI returned nothing." };

  let parsed = null;
  if (schema) {
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, reason: "unparseable", error: "The AI returned malformed JSON." }; }
  }
  return { ok: true, text, parsed, model: data.model || model, usage: data.usage || null };
}

module.exports = { callClaude, configured, DEFAULT_MODEL };
