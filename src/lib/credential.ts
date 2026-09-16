// CodeBuddy issues two credential formats and each takes a different path
// through the provider:
//   - refresh_token: a JWT (3 base64 parts, "eyJ..."). Exchanged at
//     /v2/plugin/auth/token/refresh for a fresh access token that the proxy
//     then uses as the bearer. Auto-rotated.
//   - api_key: an opaque token, prefix "ck_". Used verbatim as the bearer —
//     no refresh call, no rotation. What the upstream mints for CLI users.
//
// Detecting from the prefix is enough in practice: the CLI's refresh tokens
// start with the JWT header "eyJ" and api_keys start with "ck_". Anything
// unrecognised falls back to refresh_token, which preserves the pre-existing
// paste flow for users copying raw tokens from the CLI.

export type CredentialKind = "refresh_token" | "api_key";

export function detectCredentialType(token: string): CredentialKind {
  const t = token.trim();
  if (t.startsWith("ck_")) return "api_key";
  return "refresh_token";
}

// A fingerprint suitable for the account label — deriveLabel() only inspects
// JWT claims, so opaque api_keys would land without a label otherwise. Format:
// first 3 chars + ellipsis + last 4 chars. Distinctive enough to tell keys
// apart in the accounts table without ever showing the full secret.
export function labelForApiKey(apiKey: string): string {
  const t = apiKey.trim();
  if (t.length <= 8) return t;
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}
