// Small shared helpers.

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatDateTime(value: string | number | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Credential type detection. Mirrors src/lib/credential.ts on the backend —
// duplicated 5 lines so the dashboard bundle stays self-contained (no cross-
// boundary import from /src). CodeBuddy issues two formats:
//   - refresh_token: JWT ("eyJ..." prefix)
//   - api_key: opaque, prefix "ck_"
// Anything else defaults to refresh_token to preserve the pre-existing paste
// flow for users copying raw tokens from the CLI.
export type CredentialKind = "refresh_token" | "api_key";

export function detectCredentialType(token: string): CredentialKind {
  const t = token.trim();
  if (t.startsWith("ck_")) return "api_key";
  return "refresh_token";
}

// Cross-context clipboard write. navigator.clipboard only works in secure
// contexts (localhost or HTTPS), so a dashboard reached via plain HTTP
// (tunnel or LAN IP) silently loses copy. This falls back to the deprecated
// textarea + execCommand path in that case, which still works everywhere.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path — Safari sometimes rejects even in
      // secure context if the gesture chain looks weird.
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but selectable — display:none would block the selection.
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Deterministic chart color for a model label.
export function modelColor(label: string, index = 0): string {
  let hash = index * 31;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  const palette = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
  ];
  return palette[Math.abs(hash) % palette.length]!;
}
