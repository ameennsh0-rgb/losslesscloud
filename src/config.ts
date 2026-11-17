import 'dotenv/config';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const list = (v: string | undefined) =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const urls = list(env.TORZNAB_URL);
  const keys = list(env.TORZNAB_API_KEY);
  return {
    port: num(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? './data/losslesscloud.db',
    torznab: {
      endpoints: urls.map((url, i) => ({ url, apiKey: keys[i] ?? keys[0] ?? '' })),
      categories: env.TORZNAB_CATEGORIES ?? '3040',
    },
    torbox: {
      apiKey: env.TORBOX_API_KEY ?? '',
      baseUrl: (env.TORBOX_BASE_URL ?? 'https://api.torbox.app/v1/api').replace(/\/$/, ''),
      uncachedPerHour: 60,
      urlTtlMs: 3 * 60 * 60 * 1000,
    },
    feeds: { urls: list(env.FEED_URLS), pollMinutes: num(env.FEED_POLL_MINUTES, 30) },
    searchTtlMs: num(env.SEARCH_TTL_HOURS, 12) * 3600_000,
    onDemandTimeoutMs: num(env.ONDEMAND_TIMEOUT_MS, 8000),
    match: {
      allowUnknownDuration: bool(env.MATCH_ALLOW_UNKNOWN_DURATION, false),
      toleranceSec: num(env.MATCH_DURATION_TOLERANCE_SEC, 3),
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
