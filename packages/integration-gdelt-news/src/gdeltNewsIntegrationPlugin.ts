import { z } from "zod";
import {
  PluginKinds,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const GDELT_INTEGRATION_ID = "@prsgoo/integration-gdelt-news";
export const RECORD_TYPE_NEWS_EVENT = "news.event";

const GDELT_DOC_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

export const gdeltConfigSchema = z.object({
  query: z
    .string()
    .min(1)
    .default("(war OR conflict OR disaster OR earthquake OR storm)"),
  maxRecords: z.number().int().min(1).max(250).default(50),
  /** GDELT's DOC API rejects windows under 1 hour ("Timespan is too short"). */
  timespan: z.string().default("1h"),
});

export type GdeltConfig = z.infer<typeof gdeltConfigSchema>;

export interface NewsEventData {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  /** ISO timestamp */
  seenDate: string;
  socialImage?: string;
}

interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourcecountry: string;
  /** GDELT format: "YYYYMMDDHHMMSS" */
  seendate: string;
  socialimage?: string;
}

interface GdeltArtListResponse {
  articles?: GdeltArticle[];
}

function parseGdeltDate(gdeltDate: string): string {
  const year = gdeltDate.slice(0, 4);
  const month = gdeltDate.slice(4, 6);
  const day = gdeltDate.slice(6, 8);
  const hour = gdeltDate.slice(8, 10);
  const minute = gdeltDate.slice(10, 12);
  const second = gdeltDate.slice(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

export class GdeltNewsIntegrationPlugin implements IntegrationPlugin<GdeltConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: GDELT_INTEGRATION_ID,
    name: "GDELT News",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-articles",
        name: "Fetch Articles",
        recordType: RECORD_TYPE_NEWS_EVENT,
      },
    ],
    auth: { type: "none" },
    polling: {
      defaultIntervalMs: 15 * 60_000,
      minIntervalMs: 15 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 10,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = gdeltConfigSchema;

  private config: GdeltConfig = gdeltConfigSchema.parse({});

  configure(config: GdeltConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<NewsEventData>>> {
    if (operationId !== "fetch-articles") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const url = `${GDELT_DOC_API_URL}?query=${encodeURIComponent(this.config.query)}&mode=artlist&maxrecords=${this.config.maxRecords}&timespan=${this.config.timespan}&format=json`;
    const response = await fetch(url, { signal: context.signal ?? null });

    if (!response.ok) {
      throw new TransientError(`GDELT API returned HTTP ${response.status}.`);
    }

    const body = await response.text();
    let data: GdeltArtListResponse;
    try {
      data = JSON.parse(body) as GdeltArtListResponse;
    } catch {
      throw new TransientError(
        `GDELT returned a non-JSON response: ${body.slice(0, 120).trim()}`,
      );
    }

    if (!data.articles) return [];

    const now = context.now().toISOString();

    return data.articles.map((article) => ({
      type: RECORD_TYPE_NEWS_EVENT,
      timestamp: now,
      source: GDELT_INTEGRATION_ID,
      entityKey: `gdelt:${article.domain}:${article.seendate}`,
      data: {
        title: article.title,
        url: article.url,
        domain: article.domain,
        language: article.language,
        sourceCountry: article.sourcecountry,
        seenDate: parseGdeltDate(article.seendate),
        ...(article.socialimage !== undefined
          ? { socialImage: article.socialimage }
          : {}),
      },
    }));
  }
}
