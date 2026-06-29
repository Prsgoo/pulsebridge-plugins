import { z } from "zod";
import {
  PluginKinds,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const USGS_INTEGRATION_ID = "@prsgoo/integration-usgs-earthquakes";
export const RECORD_TYPE_SEISMIC_EVENT = "seismic.event";

const FEED_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

export const usgsConfigSchema = z.object({
  minMagnitude: z.number().min(0).max(10).default(2.5),
});

export type UsgsConfig = z.infer<typeof usgsConfigSchema>;

export interface SeismicEventData {
  magnitude: number;
  magnitudeType: string;
  place: string;
  /** Depth of the hypocenter in kilometres. */
  depth: number;
  latitude: number;
  longitude: number;
  /** USGS significance score (0–1000). Higher = more significant. */
  significance: number;
  tsunami: boolean;
  /** PAGER alert level. null when no alert has been issued. */
  alert: "green" | "yellow" | "orange" | "red" | null;
  /** USGS event page URL. */
  url: string;
  status: string;
  /** ISO timestamp of when the earthquake occurred. */
  eventTime: string;
}

interface UsgsFeatureProperties {
  mag: number | null;
  magType: string | null;
  place: string | null;
  time: number;
  sig: number;
  tsunami: number;
  alert: string | null;
  status: string;
  url: string;
}

interface UsgsFeature {
  id: string;
  properties: UsgsFeatureProperties;
  geometry: {
    coordinates: [number, number, number];
  };
}

interface UsgsGeoJsonResponse {
  features: UsgsFeature[];
}

export class UsgsEarthquakesIntegrationPlugin implements IntegrationPlugin<UsgsConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: USGS_INTEGRATION_ID,
    name: "USGS Earthquakes",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-earthquakes",
        name: "Fetch Earthquakes",
        recordType: RECORD_TYPE_SEISMIC_EVENT,
      },
    ],
    auth: { type: "none" },
    polling: {
      defaultIntervalMs: 5 * 60_000,
      minIntervalMs: 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 30,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = usgsConfigSchema;

  private config: UsgsConfig = { minMagnitude: 2.5 };

  configure(config: UsgsConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<SeismicEventData>>> {
    if (operationId !== "fetch-earthquakes") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    context.logger.debug("Fetching USGS earthquake feed.", {
      minMagnitude: this.config.minMagnitude,
    });

    const response = await fetch(FEED_URL, { signal: context.signal ?? null });

    if (response.status === 429) {
      throw new RateLimitError("USGS rate limit reached.", 60_000);
    }

    if (!response.ok) {
      throw new TransientError(`USGS API returned HTTP ${response.status}.`);
    }

    const data = (await response.json()) as UsgsGeoJsonResponse;
    const now = context.now().toISOString();

    return data.features.flatMap((feature) => {
      const p = feature.properties;
      const mag = p.mag ?? 0;

      if (mag < this.config.minMagnitude) return [];

      const [lon, lat, depth] = feature.geometry.coordinates;

      const alert = (p.alert ?? null) as SeismicEventData["alert"];

      return [
        {
          type: RECORD_TYPE_SEISMIC_EVENT,
          timestamp: now,
          source: USGS_INTEGRATION_ID,
          entityKey: `usgs:${feature.id}`,
          data: {
            magnitude: mag,
            magnitudeType: p.magType ?? "unknown",
            place: p.place ?? "unknown",
            depth,
            latitude: lat,
            longitude: lon,
            significance: p.sig,
            tsunami: p.tsunami === 1,
            alert,
            url: p.url,
            status: p.status,
            eventTime: new Date(p.time).toISOString(),
          },
        },
      ];
    });
  }
}
