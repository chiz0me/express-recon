import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateNotificationEvent, verifyWebhookSignature } = require("express-recon");

/**
 * Verify before parsing. `rawBody` must be the exact bytes received from the
 * network, before JSON/body middleware changes whitespace or encoding.
 */
export function verifyExpressReconWebhook(rawBody, headers, options = {}) {
  const secrets = [options.secret, options.previousSecret].filter(Boolean);
  const verified = verifyWebhookSignature(rawBody, headers, secrets, {
    toleranceSeconds: options.toleranceSeconds ?? 300,
  });
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
  } catch {
    throw new Error("verified webhook body is not valid JSON");
  }
  validateNotificationEvent(event);
  if (event.id !== verified.id) {
    throw new Error("verified webhook has an unexpected express-recon event contract");
  }
  return { event, id: verified.id, timestamp: verified.timestamp };
}
