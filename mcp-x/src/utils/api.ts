import { API_WAIT_MS, TARS_WAIT_MS } from "../../../mcp-shared/src/http.js";
import { readAppSettings } from "../../../mcp-shared/src/settings.js";
import { apiRequest } from "../../../mcp-shared/src/tars-api.js";

/** Tars's settings as they are now, or nothing when the file cannot be read. */
function readSettings(): Record<string, unknown> | null | undefined {
  return readAppSettings() as Record<string, unknown> | null | undefined;
}

/**
 * Refuse unless Posting is on in Settings > X (Twitter), as the settings are
 * at this call.
 *
 * The switch has been on that page, off by default, since this server shipped,
 * and nothing read it: every agent handed these tools could publish and delete
 * on the account whatever it said (the audit's lead #12), and the privacy
 * policy says Tars posts only when JeanBrasse has turned it on. Only the switch's own
 * `true` turns it on; a file with no value for it, or one that cannot be read,
 * is off.
 */
export function assertPostingEnabled(): void {
  if (readSettings()?.xPostingEnabled !== true) {
    throw new Error(
      "Posting is off in Tars Settings > X (Twitter), so nothing was sent. The user turns it on there when agents may post, reply and delete."
    );
  }
}

/**
 * One call to X, made by Tars with the account's keys (POST /api/x/request,
 * services/api-routes/integration-routes.ts): until 2.0.4 this server read
 * them out of app-settings.json and signed the call itself; they are in
 * ~/.tars-private now, which nothing handed to an agent reads. Tars answers
 * X's status and body as they came, read here as they always were, or refuses
 * (Posting off, no credentials, a call the tools do not make) with why.
 */
export async function xApiRequest(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const { status, data } = (await apiRequest(
    "/api/x/request", "POST", { method, endpoint, ...(body ? { body } : {}) }, API_WAIT_MS + TARS_WAIT_MS,
  )) as { status: number; data: string };

  // An error whose body is JSON null reads as unparseable, as it always has:
  // its .detail is read inside the try.
  let refused: Error;
  try {
    const parsed = JSON.parse(data);
    if (!(status && status >= 400)) return parsed;
    const errorDetail =
      parsed.detail ||
      parsed.errors?.[0]?.message ||
      JSON.stringify(parsed);
    refused = new Error(`X API error (HTTP ${status}): ${errorDetail}`);
  } catch {
    if (status === 204) {
      return { success: true };
    }
    throw new Error(`Failed to parse X API response: ${data.slice(0, 500)}`);
  }
  throw refused;
}
