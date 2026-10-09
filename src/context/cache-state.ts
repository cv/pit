import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Whether the provider likely still holds the conversation's prompt cache. An edit to an earlier
 * entry while it is warm rewrites the cache; once it has expired, the next request rewrites the
 * conversation anyway, so the edit costs nothing extra.
 */
export interface CacheState {
  /** `unknown` when the model has no prompt-cache lifetime for the retention tier Pi requests. */
  state: "warm" | "cold" | "unknown";
  /** Seconds since a request or Pi's cache warmer last read or wrote the cache; null if none has. */
  idleSeconds: number | null;
  /** The model's prompt-cache lifetime for that retention tier, from its `promptCache`. */
  ttlSeconds: number | null;
  /** What last refreshed the cache: a model request or a `cache_warm` refresh from Pi. */
  refreshedBy: "request" | "warming" | null;
}

interface CacheModel {
  provider: string;
  id: string;
  promptCache?: { short?: number; long?: number };
}

/** The lifetime Pi's cache warmer uses: the `long` tier with `PI_CACHE_RETENTION=long`, else `short`. */
function promptCacheTtlSeconds(
  model: CacheModel | undefined,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  return model?.promptCache?.[env.PI_CACHE_RETENTION === "long" ? "long" : "short"];
}

/**
 * The cache state of the active branch: idle time since its newest cache refresh, against the
 * model's lifetime. A compaction, branch summary, or request by another model leaves nothing of
 * this conversation cached for the current model.
 */
export function cacheState(
  branch: readonly SessionEntry[],
  model: CacheModel | undefined,
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): CacheState {
  const ttlSeconds = promptCacheTtlSeconds(model, env) ?? null;
  let refreshedAt: number | undefined;
  let refreshedBy: CacheState["refreshedBy"] = null;
  for (const entry of [...branch].reverse()) {
    if (entry.type === "compaction" || entry.type === "branch_summary") break;
    const touch = cacheTouch(entry);
    if (!touch) continue;
    if (touch.model !== `${model?.provider}/${model?.id}`) break;
    ({ at: refreshedAt, by: refreshedBy } = touch);
    break;
  }
  const idleSeconds =
    refreshedAt === undefined || !Number.isFinite(refreshedAt)
      ? null
      : Math.max(0, Math.round((now - refreshedAt) / 1000));
  return {
    state:
      ttlSeconds === null
        ? "unknown"
        : idleSeconds !== null && idleSeconds < ttlSeconds
          ? "warm"
          : "cold",
    idleSeconds,
    ttlSeconds,
    refreshedBy: idleSeconds === null ? null : refreshedBy,
  };
}

/** When and by which model an entry last read or wrote the prompt cache. */
function cacheTouch(
  entry: SessionEntry,
): { at: number; by: "request" | "warming"; model: string } | undefined {
  if (entry.type === "usage" && entry.kind === "cache_warm") {
    return {
      at: Date.parse(entry.timestamp),
      by: "warming",
      model: `${entry.provider}/${entry.model}`,
    };
  }
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  const { usage, timestamp, provider, model } = entry.message;
  // A request that failed before reaching the provider recorded no prompt tokens.
  if (usage.input + usage.cacheRead + usage.cacheWrite === 0) return undefined;
  // The cache is read when the request starts, which the message timestamp records.
  return { at: timestamp, by: "request", model: `${provider}/${model}` };
}
