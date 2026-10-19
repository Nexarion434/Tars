import { API_WAIT_MS, TARS_WAIT_MS } from "../../../mcp-shared/src/http.js";
import { apiRequest } from "../../../mcp-shared/src/tars-api.js";

/**
 * One read of SocialData, made by Tars with the user's key (POST
 * /api/socialdata/request, services/api-routes/integration-routes.ts): until
 * 2.0.4 this server read the key out of app-settings.json and called
 * SocialData itself; it is in ~/.tars-private now, which nothing handed to an
 * agent reads. Tars answers SocialData's status and body as they came, read
 * here as they always were, or refuses (no key, a call the tools do not make)
 * with why. Only reads: `method` is always GET.
 */
export async function socialDataRequest(
  _method: "GET",
  endpoint: string,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const { status, data } = (await apiRequest(
    "/api/socialdata/request", "POST", { endpoint, query: queryParams ?? {} }, API_WAIT_MS + TARS_WAIT_MS,
  )) as { status: number; data: string };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Failed to parse SocialData response: ${data.slice(0, 500)}`);
  }
  if (status && status >= 400) {
    if (status === 402) {
      throw new Error("Insufficient SocialData API credits. Please top up your account.");
    } else if (status === 404) {
      throw new Error("Resource not found on Twitter/X.");
    } else if (status === 422) {
      throw new Error(`Validation error: ${JSON.stringify(parsed)}`);
    } else {
      throw new Error(`SocialData API error (HTTP ${status}): ${JSON.stringify(parsed)}`);
    }
  }
  return parsed;
}
