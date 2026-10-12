import crypto from "node:crypto";

/**
 * Signed-in users. The host app's backend signs a short-lived HS256 JWT with a secret it
 * shares with Wicket; the widget passes it along. Only a valid token counts as signed in,
 * so budgets and plans can't be claimed from the browser.
 */
export interface Identity {
  id: string;
  name: string | null;
  email: string | null;
  plan: string | null;
}

/** Returns the identity in the token, or null when it is missing, malformed, expired or wrongly signed. */
export function verifyUserToken(token: string | undefined | null, secret: string | undefined, now = Date.now()): Identity | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let head: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (head.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) return null;

  const id = str(claims.sub) ?? str(claims.userId) ?? str(claims.id);
  if (!id) return null;
  return { id, name: str(claims.name), email: str(claims.email), plan: str(claims.plan) };
}

/** Signs a user token. The host's backend does this; Wicket uses it for the playground and tests. */
export function signUserToken(
  claims: { sub: string; name?: string; email?: string; plan?: string },
  secret: string,
  ttlSeconds = 300,
  now = Date.now(),
): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const iat = Math.floor(now / 1000);
  const payload = enc({ ...claims, iat, exp: iat + ttlSeconds });
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function str(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 320) : null;
}
