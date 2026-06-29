import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";
import { z } from "zod";

export const NASA_APOD_INTEGRATION_ID = "@prsgoo/integration-nasa-apod";
export const RECORD_TYPE_SPACE_APOD = "space.apod";

const BASE_URL = "https://api.nasa.gov/planetary/apod";

export const nasaApodConfigSchema = z.object({
  /**
   * Number of random APODs to fetch per poll (1–100).
   * When omitted, fetches today's APOD only.
   */
  count: z.number().int().min(1).max(100).optional(),
});

export type NasaApodConfig = z.infer<typeof nasaApodConfigSchema>;

export interface ApodData {
  title: string;
  explanation: string;
  /** APOD date in YYYY-MM-DD format. */
  date: string;
  /** Standard-resolution image or video URL. */
  url: string;
  /** HD image URL — only present for image-type APODs. */
  hdurl?: string;
  /** "image" or "video". */
  mediaType: string;
  copyright?: string;
}

interface NasaApodApiItem {
  title: string;
  explanation: string;
  date: string;
  url: string;
  hdurl?: string;
  media_type: string;
  copyright?: string;
}

export class NasaApodIntegrationPlugin implements IntegrationPlugin<NasaApodConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: NASA_APOD_INTEGRATION_ID,
    name: "NASA Astronomy Picture of the Day",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-apod",
        name: "Fetch APOD",
        recordType: RECORD_TYPE_SPACE_APOD,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "NASA_API_KEY",
          description:
            "NASA API key from api.nasa.gov. Use DEMO_KEY for casual testing (30 req/hr limit).",
          required: true,
        },
      ],
    },
    polling: {
      defaultIntervalMs: 6 * 60 * 60_000,
      minIntervalMs: 60 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 30,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = nasaApodConfigSchema;

  private config: NasaApodConfig = {};

  configure(config: NasaApodConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<ApodData>>> {
    if (operationId !== "fetch-apod") {
      throw new Error(
        `Operation '${operationId}' is not supported by '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("NASA_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError("NASA_API_KEY secret is required but not set.");
    }

    const url = new URL(BASE_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("thumbs", "true");
    if (this.config.count !== undefined) {
      url.searchParams.set("count", String(this.config.count));
    }

    context.logger.debug("Fetching APOD.", {
      count: this.config.count ?? "today",
    });

    const response = await fetch(url.toString(), {
      signal: context.signal ?? null,
    });

    if (response.status === 403) {
      throw new PluginAuthError("Invalid NASA API key.");
    }

    if (response.status === 429) {
      const retryAfter =
        response.headers.get("X-Retry-After") ??
        response.headers.get("Retry-After");
      throw new RateLimitError(
        "NASA APOD rate limit reached.",
        retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : undefined,
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `NASA APOD API returned HTTP ${response.status}.`,
      );
    }

    const body = (await response.json()) as unknown;
    const items: NasaApodApiItem[] = Array.isArray(body)
      ? (body as NasaApodApiItem[])
      : [body as NasaApodApiItem];

    return items.map((item) => ({
      type: RECORD_TYPE_SPACE_APOD,
      timestamp: context.now().toISOString(),
      source: NASA_APOD_INTEGRATION_ID,
      entityKey: `apod:${item.date}`,
      data: {
        title: item.title,
        explanation: item.explanation,
        date: item.date,
        url: item.url,
        mediaType: item.media_type,
        ...(item.hdurl !== undefined ? { hdurl: item.hdurl } : {}),
        ...(item.copyright !== undefined ? { copyright: item.copyright } : {}),
      },
    }));
  }
}
