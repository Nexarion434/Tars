/**
 * API utilities for communicating with tars API server
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "node:http";
import * as https from "node:https";

const API_URL = process.env.CLAUDE_MGR_API_URL || "http://127.0.0.1:31415";
const API_TOKEN_FILE = path.join(os.homedir(), ".dorothy", "api-token");

// Caller identity, injected into the PTY environment by Tars when it spawns
// the agent. Sent on every request so the server can scope agent listings and
// reject cross-project actions (the "orchestrator drove another project's
// agents" bug).
const CALLER_AGENT_ID = process.env.CLAUDE_AGENT_ID || "";
const CALLER_PROJECT_PATH = process.env.CLAUDE_PROJECT_PATH || "";

export function getCallerIdentity(): { agentId: string; projectPath: string } {
  return { agentId: CALLER_AGENT_ID, projectPath: CALLER_PROJECT_PATH };
}

function readApiToken(): string | null {
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      return fs.readFileSync(API_TOKEN_FILE, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return null;
}

/** Bodies stay small: an agent listing, a status, a captured output. This is
 *  a guard against a runaway response, not a real protocol limit. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * One request, over node:http, with the caller's timeout as the only clock.
 *
 * This used to be `fetch`. Node's fetch is undici, and undici applies two
 * timers of its own that nothing here sets or sees: `headersTimeout` and
 * `bodyTimeout`, 300000ms each. Both of them count silence, and a long poll
 * is silence by definition: /wait and /run-task send no byte at all until the
 * agent's status changes or its turn ends. So a wait or a delegation that
 * outlived undici's timer did not fail at the deadline it was given; the
 * socket was cut underneath it and the whole thing surfaced as
 * `TypeError: fetch failed`, with no status, no code and no duration - which
 * is exactly what an orchestrator saw two or three minutes into a delegation.
 *
 * node:http has no such hidden timer. `setTimeout` below is an inactivity
 * timeout, which for a long poll is the overall budget, and it is the budget
 * the caller asked for. A timeout now says how long it waited, and a socket
 * error now carries its errno instead of being flattened.
 */
function requestJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; data: unknown }> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`Response from ${target.pathname} exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown = undefined;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              reject(new Error(`API returned non-JSON (${res.statusCode}): ${raw.slice(0, 200)}`));
              return;
            }
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );

    // Counts silence, which is what a long poll is made of. Firing means the
    // budget the caller set has run out, and the message says so.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${method} ${target.pathname}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
  timeoutMsOverride?: number
): Promise<unknown> {
  const url = `${API_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Marks this as an agent-initiated call, so the server can refuse to act
    // when the caller turns out to have no identity to scope it by.
    "X-Tars-Client": "mcp",
  };
  const token = readApiToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (CALLER_AGENT_ID) {
    headers["X-Tars-Caller-Id"] = CALLER_AGENT_ID;
  }
  if (CALLER_PROJECT_PATH) {
    headers["X-Tars-Caller-Project"] = CALLER_PROJECT_PATH;
  }

  // Long-poll wait endpoints need a longer budget. Callers passing a custom
  // wait timeout must override this so the client never gives up before the
  // server-side long-poll resolves.
  const isLongPoll = endpoint.includes("/wait");
  const timeoutMs = timeoutMsOverride ?? (isLongPoll ? 600_000 : 30_000);

  const payload = body ? JSON.stringify(body) : undefined;
  if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

  const { status, data } = await requestJson(url, method, headers, payload, timeoutMs);

  if (status < 200 || status >= 300) {
    throw new Error((data as { error?: string })?.error || `API error: ${status}`);
  }

  return data;
}
