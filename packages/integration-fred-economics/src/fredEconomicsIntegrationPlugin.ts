import { z } from "zod";
import {
  PluginKinds,
  PluginAuthError,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const FRED_INTEGRATION_ID = "@prsgoo/integration-fred-economics";
export const RECORD_TYPE_ECONOMIC_INDICATOR = "economic.indicator";

const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

export const fredConfigSchema = z.object({
  series: z
    .array(z.string().min(1))
    .min(1)
    .default(["FEDFUNDS", "CPIAUCSL", "UNRATE", "GDP", "DGS10"]),
});

export type FredConfig = z.infer<typeof fredConfigSchema>;

export interface EconomicIndicatorData {
  seriesId: string;
  value: number;
  /** YYYY-MM-DD observation date */
  date: string;
  realtimeStart: string;
  realtimeEnd: string;
}

interface FredObservation {
  realtime_start: string;
  realtime_end: string;
  date: string;
  /** FRED uses "." to indicate missing data. */
  value: string;
}

interface FredObservationsResponse {
  observations: FredObservation[];
}

export class FredEconomicsIntegrationPlugin implements IntegrationPlugin<FredConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: FRED_INTEGRATION_ID,
    name: "FRED Economics",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-indicators",
        name: "Fetch Indicators",
        recordType: RECORD_TYPE_ECONOMIC_INDICATOR,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [{ key: "FRED_API_KEY", required: true }],
    },
    polling: {
      defaultIntervalMs: 60 * 60_000,
      minIntervalMs: 15 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = fredConfigSchema;

  private config: FredConfig = fredConfigSchema.parse({});

  configure(config: FredConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<EconomicIndicatorData>>> {
    if (operationId !== "fetch-indicators") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("FRED_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError("FRED_API_KEY secret is required but not set.");
    }

    const records: PulseRecord<EconomicIndicatorData>[] = [];
    const now = context.now().toISOString();

    for (const seriesId of this.config.series) {
      const url = `${FRED_BASE_URL}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
      const response = await fetch(url, { signal: context.signal ?? null });

      if (response.status === 429) {
        throw new RateLimitError("FRED rate limit reached.", 60_000);
      }
      if (response.status === 403) {
        throw new PluginAuthError("FRED API key is invalid.");
      }
      if (!response.ok) {
        throw new TransientError(`FRED API returned HTTP ${response.status}.`);
      }

      const data = (await response.json()) as FredObservationsResponse;

      const [obs] = data.observations;

      if (!obs || obs.value === ".") continue;

      records.push({
        type: RECORD_TYPE_ECONOMIC_INDICATOR,
        timestamp: now,
        source: FRED_INTEGRATION_ID,
        entityKey: `fred:${seriesId}:${obs.date}`,
        data: {
          seriesId,
          value: parseFloat(obs.value),
          date: obs.date,
          realtimeStart: obs.realtime_start,
          realtimeEnd: obs.realtime_end,
        },
      });
    }

    return records;
  }
}
