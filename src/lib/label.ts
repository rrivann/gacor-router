// Derive a human-readable account label from the JWT claims in a credential
// pair. Preferred over "provider-N" defaults because it stays stable when the
// row's numeric id shifts, and it tells the user which upstream identity the
// row actually holds.

import { labelForApiKey } from "./credential";

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The upstream identity behind a credential pair. `sub` is what CodeBuddy's
// Keycloak realm uses to link a session to a user — two credentials with the
// same sub are the same account in the pool's eyes even if the RT strings
// differ. Returns null when the JWT can't be decoded.
export function deriveIdentity(creds: Record<string, string> | null | undefined): string | null {
  if (!creds) return null;
  const at = decodeJwtPayload(creds.access_token);
  const rt = decodeJwtPayload(creds.refresh_token);
  const sub = asString(at?.sub) ?? asString(rt?.sub);
  return sub;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Try, in order:
//   AT.preferred_username → AT.email local-part → AT.sub prefix → RT.sub prefix
// Returns null when nothing usable is present (RT-only account whose RT is
// opaque, for example) — the caller can then keep the row's existing label.
export function deriveLabel(creds: Record<string, string> | null | undefined): string | null {
  if (!creds) return null;
  const at = decodeJwtPayload(creds.access_token);
  const rt = decodeJwtPayload(creds.refresh_token);

  const pu = asString(at?.preferred_username);
  if (pu) return pu;

  const email = asString(at?.email);
  if (email) {
    const local = email.split("@")[0];
    if (local) return local;
  }

  const atSub = asString(at?.sub);
  if (atSub) return atSub.slice(0, 8);

  const rtSub = asString(rt?.sub);
  if (rtSub) return rtSub.slice(0, 8);

  // Opaque api_key (no JWT claims to mine). Fingerprint it so the row still
  // gets a distinctive label instead of a blank one.
  const apiKey = asString(creds.api_key);
  if (apiKey) return labelForApiKey(apiKey);

  return null;
}
