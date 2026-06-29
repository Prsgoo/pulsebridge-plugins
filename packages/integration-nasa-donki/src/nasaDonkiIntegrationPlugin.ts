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
import { z } from "zod";

export const NASA_DONKI_INTEGRATION_ID = "@prsgoo/integration-nasa-donki";
export const RECORD_TYPE_SOLAR_FLARE = "space.solar-flare";

const BASE_URL = "https://api.nasa.gov/DONKI/FLR";

export const donkiConfigSchema = z.object({
  /**
   * How many days back to fetch solar flare events.
   * DONKI returns all events in the [startDate, endDate] window.
   */
  lookbackDays: z.number().int().min(1).max(30).default(7),
});

export type DonkiConfig = z.infer<typeof donkiConfigSchema>;

export type FlareClass = "A" | "B" | "C" | "M" | "X";
export type FlareSeverity = "minor" | "moderate" | "significant" | "major";

export interface SolarFlareData {
  flrId: string;
  classType: string;
  /** Broad severity bucket derived from classType prefix. */
  severity: FlareSeverity;
  beginTime: string;
  peakTime: string | null;
  endTime: string | null;
  sourceLocation: string | null;
  activeRegionNum: number | null;
  note: string;
  linkedEventIds: string[];
  link: string;
}

interface DonkiFlarRaw {
  flrID: string;
  classType: string;
  beginTime: string;
  peakTime?: string | null;
  endTime?: string | null;
  sourceLocation?: string | null;
  activeRegionNum?: number | null;
  note?: string | null;
  linkedEvents?: Array<{ activityID: string }> | null;
  link: string;
}

function parseSeverity(classType: string): FlareSeverity {
  const prefix = classType.charAt(0).toUpperCase() as FlareClass;
  switch (prefix) {
    case "X":
      return "major";
    case "M":
      return "significant";
    case "C":
      return "moderate";
    default:
      return "minor";
  }
}

function toIsoDate(date: Date): string {
  return date.toISOString().substring(0, 10);
}

export class NasaDonkiIntegrationPlugin implements IntegrationPlugin<DonkiConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: NASA_DONKI_INTEGRATION_ID,
    name: "NASA DONKI Solar Flares",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-solar-flares",
        name: "Fetch Solar Flares",
        recordType: RECORD_TYPE_SOLAR_FLARE,
      },
    ],
    auth: {
      type: "apiKey",
      secrets: [
        {
          key: "NASA_API_KEY",
          description:
            "NASA Open APIs key — get one free at api.nasa.gov. Use DEMO_KEY for testing.",
          required: true,
        },
      ],
    },
    polling: {
      defaultIntervalMs: 60 * 60_000,
      minIntervalMs: 15 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 10,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = donkiConfigSchema;

  private config: DonkiConfig = { lookbackDays: 7 };

  configure(config: DonkiConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<SolarFlareData>>> {
    if (operationId !== "fetch-solar-flares") {
      throw new Error(
        `Operation '${operationId}' is not supported by '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("NASA_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError("NASA_API_KEY secret is not configured.");
    }

    const now = context.now();
    const startDate = toIsoDate(
      new Date(now.getTime() - this.config.lookbackDays * 86_400_000),
    );
    const endDate = toIsoDate(now);

    const url = new URL(BASE_URL);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("api_key", apiKey);

    context.logger.debug("Fetching DONKI solar flares.", {
      startDate,
      endDate,
    });

    const response = await fetch(url.toString(), {
      signal: context.signal ?? null,
    });

    if (response.status === 403) {
      throw new PluginAuthError("NASA API key is invalid or unauthorized.");
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("X-Retry-After");
      throw new RateLimitError(
        "NASA DONKI rate limit reached.",
        retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : 60_000,
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `NASA DONKI API returned HTTP ${response.status}.`,
      );
    }

    const data = (await response.json()) as DonkiFlarRaw[];

    if (!Array.isArray(data)) {
      context.logger.warn("Unexpected DONKI response shape — expected array.");
      return [];
    }

    const fetchedAt = now.toISOString();

    return data.map((raw) => ({
      type: RECORD_TYPE_SOLAR_FLARE,
      timestamp: fetchedAt,
      source: NASA_DONKI_INTEGRATION_ID,
      entityKey: `flare:${raw.flrID}`,
      data: {
        flrId: raw.flrID,
        classType: raw.classType,
        severity: parseSeverity(raw.classType),
        beginTime: raw.beginTime,
        peakTime: raw.peakTime ?? null,
        endTime: raw.endTime ?? null,
        sourceLocation: raw.sourceLocation ?? null,
        activeRegionNum: raw.activeRegionNum ?? null,
        note: raw.note ?? "",
        linkedEventIds: raw.linkedEvents?.map((e) => e.activityID) ?? [],
        link: raw.link,
      },
    }));
  }
}
