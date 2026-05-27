/**
 * Write-action audit + bulk-operation alerting.
 *
 * Wraps each write-tool handler with `audited()` so every write emits a
 * structured Cloud Logging entry (`event: "write"`) carrying:
 *   - userEmail, tool, objectsModified, presentationId, detail
 *   - outcome (ok | error), durationMs, optional error text
 *
 * When a successful write modifies more than `BULK_OP_THRESHOLD` objects
 * (default 20), a Slack DM is posted to `BULK_OP_ALERT_USER_ID` via
 * `chat.postMessage`. Sensitive board/QBR decks make this trail important.
 * The post is fire-and-forget so user-facing latency is unaffected.
 */

import { logger } from "./logger.js";

const THRESHOLD = parseInt(process.env.BULK_OP_THRESHOLD ?? "20", 10);
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const ALERT_USER_ID = process.env.BULK_OP_ALERT_USER_ID ?? "";

if (!SLACK_TOKEN || !ALERT_USER_ID) {
  logger.warn("Bulk-op Slack alerting not fully configured", {
    hasToken: Boolean(SLACK_TOKEN),
    hasAlertUserId: Boolean(ALERT_USER_ID),
    threshold: THRESHOLD,
  });
} else {
  logger.info("Bulk-op Slack alerting enabled", { threshold: THRESHOLD, alertUserId: ALERT_USER_ID });
}

export interface WriteScope {
  /** Number of objects/occurrences changed (text replacements, cells, charts, or 1 for single-object ops). */
  objectsModified: number;
  presentationId?: string;
  /** Short human note, e.g. "duplicated template" or "12 cells". */
  detail?: string;
}

interface ToolResult {
  isError?: boolean;
  content: unknown;
}

/** True when a successful op modified more objects than the alert threshold. */
export function exceedsThreshold(objectsModified: number, threshold: number = THRESHOLD): boolean {
  return objectsModified > threshold;
}

/** Build the Slack alert text for a bulk operation (pure — unit tested). */
export function buildBulkAlertText(payload: {
  userEmail: string;
  tool: string;
  objectsModified: number;
  presentationId?: string;
  detail?: string;
  durationMs: number;
}, threshold: number = THRESHOLD): string {
  const deckLink = payload.presentationId
    ? `<https://docs.google.com/presentation/d/${payload.presentationId}/edit|open deck>`
    : "_(no presentation id captured)_";
  return [
    `:rotating_light: *Bulk operation on google-slides-mcp* (>${threshold} objects)`,
    `• *User:* \`${payload.userEmail}\``,
    `• *Tool:* \`${payload.tool}\``,
    `• *Objects modified:* ${payload.objectsModified.toLocaleString()}`,
    payload.detail ? `• *Detail:* ${payload.detail}` : null,
    `• *Presentation:* ${deckLink}`,
    `• *Duration:* ${payload.durationMs}ms`,
  ].filter(Boolean).join("\n");
}

/**
 * Wraps a write-tool handler:
 *   1. Computes WriteScope from args
 *   2. Runs the handler
 *   3. Emits a structured "write" log entry
 *   4. Fires a Slack DM if objectsModified exceeds the threshold and the call succeeded
 */
export function audited<TArgs, TResult extends ToolResult>(
  toolName: string,
  userEmail: string,
  computeScope: (args: TArgs) => WriteScope,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    const startMs = Date.now();
    const scope = computeScope(args);
    let outcome: "ok" | "error" = "ok";
    let errorText: string | undefined;
    let result: TResult | undefined;

    try {
      result = await handler(args);
      if (result.isError) {
        outcome = "error";
        const content = result.content as Array<{ text?: string }> | undefined;
        errorText = content?.[0]?.text;
      }
      return result;
    } catch (err) {
      outcome = "error";
      errorText = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const durationMs = Date.now() - startMs;

      logger.info("Write performed", {
        event: "write",
        userEmail,
        tool: toolName,
        objectsModified: scope.objectsModified,
        ...(scope.presentationId ? { presentationId: scope.presentationId } : {}),
        ...(scope.detail ? { detail: scope.detail } : {}),
        outcome,
        durationMs,
        ...(errorText ? { error: errorText } : {}),
      });

      if (outcome === "ok" && exceedsThreshold(scope.objectsModified)) {
        // Fire-and-forget — never block the user.
        void emitBulkAlert({
          userEmail,
          tool: toolName,
          objectsModified: scope.objectsModified,
          presentationId: scope.presentationId,
          detail: scope.detail,
          durationMs,
        }).catch((e) =>
          logger.warn("Bulk-op Slack post failed", {
            event: "bulk_op_alert_failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    }
  };
}

async function emitBulkAlert(payload: {
  userEmail: string;
  tool: string;
  objectsModified: number;
  presentationId?: string;
  detail?: string;
  durationMs: number;
}): Promise<void> {
  if (!SLACK_TOKEN || !ALERT_USER_ID) {
    logger.warn("Bulk op detected but Slack not configured — skipping DM", {
      event: "bulk_op_alert_failed",
      userEmail: payload.userEmail,
      tool: payload.tool,
      objectsModified: payload.objectsModified,
    });
    return;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: ALERT_USER_ID, text: buildBulkAlertText(payload) }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logger.warn("Slack chat.postMessage returned not-ok", {
      event: "bulk_op_alert_failed",
      error: body.error,
      userEmail: payload.userEmail,
      tool: payload.tool,
    });
    return;
  }
  logger.info("Bulk op Slack alert sent", {
    event: "bulk_op_alert",
    userEmail: payload.userEmail,
    tool: payload.tool,
    objectsModified: payload.objectsModified,
  });
}
