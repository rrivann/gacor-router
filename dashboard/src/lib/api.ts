// API client for the gacor-router management surface. All calls are same-
// origin (served by the backend in prod, proxied by Vite in dev) and
// unauthenticated — the router binds to localhost.

export interface ApiError {
  error: { message: string; type: string; code: string | null };
}

export async function fetchApi<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiError;
      if (body.error?.message) message = body.error.message;
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── Types mirroring the backend rows ─────────────────────────────

export interface AccountRow {
  id: number;
  provider: string;
  label: string | null;
  status: string;
  createdAt: string;
  hasSecret: boolean;
  credKeys: string[];
  usage: CreditUsage | null;
  usageAt: string | null;
}

export interface UsagePackage {
  name: string;
  subProduct?: string;
  kind?: "monthly" | "lifetime";
  limit: number;
  used: number;
  remaining: number;
  resetAtUnix?: number;
}

export interface CreditUsage {
  limit: number;
  used: number;
  remaining: number;
  plan?: string;
  message?: string;
  resetAtUnix?: number;
  packages?: UsagePackage[];
}

export interface RequestLogRow {
  id: number;
  createdAt: string;
  provider: string;
  model: string | null;
  accountId: number | null;
  accountLabel: string | null;
  stream: boolean;
  source: string;
  status: string;
  httpStatus: number | null;
  outcome: string | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  ttftMs: number | null;
  creditUsed: number | null;
  dollarCost: number | null;
  errorMessage: string | null;
}

export interface RequestLogDetail extends RequestLogRow {
  requestBody: string | null;
  responseBody: string | null;
}

export interface DashboardStats {
  pool: { total: number; active: number; exhausted: number; banned: number };
  requests: { total: number; success: number };
  tokens: { total: number; prompt: number; completion: number };
}

export interface ModelUsageRow {
  provider: string;
  model: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  thinking: boolean;
  credit_multiplier: number | null;
  thinking_toggle: "canDisable" | "onlyReasoning" | null;
  effort: string | null;
  images: boolean;
  tool_calls: boolean;
  kind: "chat" | "image";
}

export interface RequestLogEvent {
  id: number;
  provider: string;
  model: string;
  accountId: number | null;
  accountLabel: string | null;
  status: string;
  httpStatus: number | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

// ── Endpoints ────────────────────────────────────────────────────

export const fetchAccounts = (provider?: string) =>
  fetchApi<{ data: AccountRow[] }>(`/api/accounts${provider ? `?provider=${provider}` : ""}`);

export const createAccount = (row: {
  provider: string;
  label?: string;
  secret?: string;
  creds?: Record<string, string>;
}) => fetchApi<{ success: boolean; id: number }>("/api/accounts", { method: "POST", body: JSON.stringify(row) });

export const deleteAccount = (id: number) =>
  fetchApi<{ success: boolean }>(`/api/accounts/${id}`, { method: "DELETE" });

export const revealAccount = (id: number) =>
  fetchApi<{ id: number; secret: string; creds: Record<string, string> }>(`/api/accounts/${id}/reveal`);

export const setAccountStatus = (id: number, status: string) =>
  fetchApi<{ success: boolean }>(`/api/accounts/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });

export const refreshUsage = (id: number) =>
  fetchApi<{ data: CreditUsage }>(`/api/accounts/${id}/usage/refresh`, { method: "POST" });

// ── Warmup ───────────────────────────────────────────────────────

export interface WarmResult {
  ok: boolean;
  outcome: string;
  status: string;
  latencyMs: number;
  credit?: { remaining: number; limit: number };
  error?: string;
}

export const warmAccount = (id: number) =>
  fetchApi<WarmResult>(`/api/accounts/${id}/warmup`, { method: "POST" });

export const warmAll = (provider: string, statuses?: string[]) =>
  fetchApi<{ success: boolean; total: number; ok: number; results: { id: number; ok: boolean; status: string }[] }>(
    `/api/accounts/warmup-all?provider=${encodeURIComponent(provider)}${statuses?.length ? `&statuses=${statuses.join(",")}` : ""}`,
    { method: "POST" }
  );

export interface AutoWarmConfig {
  enabled: boolean;
  intervalMinutes: number;
  statuses: string[];
  concurrency: number;
  skipRecentlyWarmed: boolean;
}

export const fetchAutoWarmConfig = (provider: string) =>
  fetchApi<AutoWarmConfig>(`/api/providers/${encodeURIComponent(provider)}/auto-warmup`);

export const saveAutoWarmConfig = (provider: string, cfg: Partial<AutoWarmConfig>) =>
  fetchApi<AutoWarmConfig>(`/api/providers/${encodeURIComponent(provider)}/auto-warmup`, {
    method: "PUT",
    body: JSON.stringify(cfg),
  });

export const fetchRequestLogs = (opts?: { limit?: number; offset?: number; provider?: string }) => {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.provider) params.set("provider", opts.provider);
  const qs = params.toString();
  return fetchApi<{ data: RequestLogRow[] }>(`/api/stats/requests${qs ? `?${qs}` : ""}`);
};

export const fetchRequestDetail = (id: number) =>
  fetchApi<{ data: RequestLogDetail }>(`/api/stats/requests/${id}`);

export const fetchDashboardStats = () => fetchApi<DashboardStats>("/api/stats/dashboard");

export const fetchModelUsage = () => fetchApi<{ data: ModelUsageRow[] }>("/api/stats/models");

export type UsageRange = "1d" | "7d" | "30d" | "all";

export interface UsageBucket {
  t: number; // bucket start, unix ms
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageReport {
  range: UsageRange;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
  buckets: UsageBucket[];
  models: ModelUsageRow[];
}

export const fetchUsage = (range: UsageRange) =>
  fetchApi<UsageReport>(`/api/stats/usage?range=${range}`);

export const fetchModels = () => fetchApi<{ object: string; data: ModelInfo[] }>("/v1/models");

export const fetchSettings = () => fetchApi<{ data: Record<string, string> }>("/api/settings");

export const saveSettings = (settings: Record<string, string>) =>
  fetchApi<{ success: boolean; data: Record<string, string> }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });

export const deleteSetting = (key: string) =>
  fetchApi<{ success: boolean }>(`/api/settings/${encodeURIComponent(key)}`, { method: "DELETE" });

// ── Tunnel ───────────────────────────────────────────────────────

export interface TunnelStatus {
  enabled: boolean;
  running: boolean;
  url: string | null;
  enabling: boolean;
  download: { downloading: boolean; progress: number; error: string | null };
}

export const fetchTunnelStatus = () => fetchApi<TunnelStatus>("/api/tunnel/status");

export const enableTunnel = () =>
  fetchApi<{ success: boolean; url?: string }>("/api/tunnel/enable", { method: "POST" });

export const disableTunnel = () =>
  fetchApi<{ success: boolean }>("/api/tunnel/disable", { method: "POST" });

// ── AI Chat sessions ─────────────────────────────────────────────

export interface ChatSessionListRow {
  id: number;
  title: string;
  model: string;
  msgCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionRow extends ChatSessionListRow {
  messages: string;
}

export const fetchChatSessions = () =>
  fetchApi<{ sessions: ChatSessionListRow[] }>("/api/chat/sessions");

export const fetchChatSession = (id: number) => fetchApi<ChatSessionRow>(`/api/chat/sessions/${id}`);

export const createChatSession = (row: { title?: string; model?: string }) =>
  fetchApi<{ id: number }>("/api/chat/sessions", { method: "POST", body: JSON.stringify(row) });

export const updateChatSession = (
  id: number,
  row: { title?: string; model?: string; messages?: string; msgCount?: number }
) => fetchApi<{ ok: boolean }>(`/api/chat/sessions/${id}`, { method: "PUT", body: JSON.stringify(row) });

export const deleteChatSession = (id: number) =>
  fetchApi<{ ok: boolean }>(`/api/chat/sessions/${id}`, { method: "DELETE" });

// ── Content filters ──────────────────────────────────────────────

export interface ContentFilter {
  id: number;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
  sort: number;
  providerScope: string[] | null;
  createdAt: string;
}

export const fetchFilters = () => fetchApi<{ data: ContentFilter[] }>("/api/filters");

export const createFilter = (row: {
  pattern: string;
  replacement?: string;
  isRegex?: boolean;
  isActive?: boolean;
  sort?: number;
  providerScope?: string[] | null;
}) => fetchApi<{ id: number }>("/api/filters", { method: "POST", body: JSON.stringify(row) });

export const updateFilter = (
  id: number,
  patch: Partial<Pick<ContentFilter, "pattern" | "replacement" | "isRegex" | "isActive" | "sort" | "providerScope">>
) => fetchApi<{ ok: boolean }>(`/api/filters/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteFilter = (id: number) =>
  fetchApi<{ ok: boolean }>(`/api/filters/${id}`, { method: "DELETE" });

// ── API keys ─────────────────────────────────────────────────────

export interface ApiKey {
  id: number;
  label: string;
  secret: string;
  enabled: boolean;
  tokenLimit: number;
  tokensUsed: number;
  maxConcurrent: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  createdAt: string;
}

export const fetchApiKeys = () => fetchApi<{ data: ApiKey[] }>("/api/keys");

export const createApiKey = (row: {
  label?: string;
  tokenLimit?: number;
  maxConcurrent?: number;
  expiresAt?: string | number | null;
  allowedModels?: string[] | null;
  allowedProviders?: string[] | null;
}) => fetchApi<{ id: number; secret: string }>("/api/keys", { method: "POST", body: JSON.stringify(row) });

export const updateApiKey = (
  id: number,
  patch: Partial<
    Pick<
      ApiKey,
      "label" | "enabled" | "tokenLimit" | "maxConcurrent" | "expiresAt" | "allowedModels" | "allowedProviders"
    >
  >
) => fetchApi<{ ok: boolean }>(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteApiKey = (id: number) =>
  fetchApi<{ ok: boolean }>(`/api/keys/${id}`, { method: "DELETE" });

// ── Process debug ────────────────────────────────────────────────

export interface DebugProcess {
  process: { cpuPercent: number; rss: number; pid: number };
  memory: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
  eventLoop: { delayMs: number };
  build: {
    bunVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    numCpu: number;
  };
  uptimeSeconds: number;
  now: string;
}

export const fetchDebugProcess = () => fetchApi<DebugProcess>("/api/debug/process");
