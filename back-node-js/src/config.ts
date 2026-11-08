import 'dotenv/config';

export interface Settings {
  yandexToken: string | null;
  yandexProxy: string | null;
  ytmProxy: string | null;
  ytmTimeout: number;
  searchConcurrency: number;
  matchAccept: number;
  matchUncertain: number;
  durationTolerance: number;
  dbHost: string | null;
  dbPort: number;
  dbName: string | null;
  dbUser: string | null;
  dbPassword: string | null;
  host: string;
}

export const settings: Settings = {
  yandexToken: process.env.YANDEX_TOKEN || null,
  yandexProxy: process.env.YANDEX_PROXY || null,
  ytmProxy: process.env.YTM_PROXY || null,
  ytmTimeout: Number(process.env.YTM_TIMEOUT ?? 20000),
  searchConcurrency: Number(process.env.SEARCH_CONCURRENCY ?? 4),
  matchAccept: Number(process.env.MATCH_ACCEPT ?? 0.75),
  matchUncertain: Number(process.env.MATCH_UNCERTAIN ?? 0.55),
  durationTolerance: Number(process.env.DURATION_TOLERANCE ?? 5),
  dbHost: process.env.DB_HOST || null,
  dbPort: Number(process.env.DB_PORT ?? 3306),
  dbName: process.env.DB_DATABASE || null,
  dbUser: process.env.DB_USERNAME || null,
  dbPassword: process.env.DB_PASSWORD || null,
  host: process.env.HOST ?? '0.0.0.0',
};

export function applyYtmProxy(): void {
  if (settings.ytmProxy) {
    process.env.HTTP_PROXY = settings.ytmProxy;
    process.env.HTTPS_PROXY = settings.ytmProxy;
    process.env.http_proxy = settings.ytmProxy;
    process.env.https_proxy = settings.ytmProxy;
  }
}