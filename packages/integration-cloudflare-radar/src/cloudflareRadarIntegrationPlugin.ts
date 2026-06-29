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

export const CFRADAR_INTEGRATION_ID = "@prsgoo/integration-cloudflare-radar";
export const RECORD_TYPE_INTERNET_ANOMALY = "internet.anomaly";

const CFRADAR_BASE_URL = "https://api.cloudflare.com/client/v4/radar";

const DEFAULT_DATE_RANGE = "7d";

export const cloudflareRadarConfigSchema = z.object({
  /** ISO alpha-2 country code filter, e.g. "US". Omit for global. */
  location: z.string().optional(),
  /** Lookback window accepted by the Radar API, e.g. "1d", "7d", "28d". */
  dateRange: z
    .string()
    .regex(/^\d+d$/, "dateRange must look like '7d'")
    .optional(),
});

export type CloudflareRadarConfig = z.infer<typeof cloudflareRadarConfigSchema>;

export interface InternetAnomalyData {
  anomalyType: "traffic" | "bgp_hijack";
  startDate: string;
  endDate?: string;
  status?: string;
  location?: string;
  asn?: number;
  asnName?: string;
  description?: string;
}

interface CfTrafficAnomaly {
  uuid: string;
  startDate: string;
  endDate?: string | null;
  status: string;
  locationDetails?: { code: string; name: string } | null;
  asnDetails?: { asn: string; name: string } | null;
}

interface CfTrafficAnomaliesResponse {
  result: {
    trafficAnomalies: CfTrafficAnomaly[];
  };
}

interface CfBgpHijackEvent {
  id: number;
  min_hijack_ts: string;
  max_hijack_ts?: string | null;
  hijacker_asn: number;
}

interface CfAsnInfo {
  asn: number;
  org_name: string;
}

interface CfBgpHijacksResponse {
  result: {
    events: CfBgpHijackEvent[];
    asn_info: CfAsnInfo[];
  };
}

export class CloudflareRadarIntegrationPlugin implements IntegrationPlugin<CloudflareRadarConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: CFRADAR_INTEGRATION_ID,
    name: "Cloudflare Radar",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-traffic-anomalies",
        name: "Fetch Traffic Anomalies",
        recordType: RECORD_TYPE_INTERNET_ANOMALY,
      },
      {
        id: "fetch-bgp-hijacks",
        name: "Fetch BGP Hijacks",
        recordType: RECORD_TYPE_INTERNET_ANOMALY,
      },
    ],
    auth: {
      type: "bearerToken",
      secrets: [{ key: "CLOUDFLARE_RADAR_TOKEN", required: true }],
    },
    polling: {
      defaultIntervalMs: 15 * 60_000,
      minIntervalMs: 5 * 60_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = cloudflareRadarConfigSchema;

  private config: CloudflareRadarConfig = {};

  configure(config: CloudflareRadarConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<InternetAnomalyData>>> {
    const token = context.secrets.get("CLOUDFLARE_RADAR_TOKEN");
    if (!token) {
      throw new PluginAuthError(
        "CLOUDFLARE_RADAR_TOKEN secret is required but not set.",
      );
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const now = context.now().toISOString();
    const dateRange = this.config.dateRange ?? DEFAULT_DATE_RANGE;

    if (operationId === "fetch-traffic-anomalies") {
      const locationParam = this.config.location
        ? `&location=${this.config.location}`
        : "";
      const url = `${CFRADAR_BASE_URL}/traffic_anomalies?limit=100&dateRange=${dateRange}&format=JSON${locationParam}`;
      const data = await this.fetchRadar<CfTrafficAnomaliesResponse>(
        url,
        headers,
        context,
      );

      return data.result.trafficAnomalies.map((anomaly) => ({
        type: RECORD_TYPE_INTERNET_ANOMALY,
        timestamp: now,
        source: CFRADAR_INTEGRATION_ID,
        entityKey: `cfradar:traffic:${anomaly.uuid}`,
        data: {
          anomalyType: "traffic" as const,
          startDate: anomaly.startDate,
          ...(anomaly.endDate != null ? { endDate: anomaly.endDate } : {}),
          status: anomaly.status,
          ...(anomaly.locationDetails != null
            ? { location: anomaly.locationDetails.name }
            : {}),
          ...(anomaly.asnDetails != null
            ? {
                asn: Number(anomaly.asnDetails.asn),
                asnName: anomaly.asnDetails.name,
              }
            : {}),
        },
      }));
    }

    if (operationId === "fetch-bgp-hijacks") {
      const locationParam = this.config.location
        ? `&involvedCountry=${this.config.location}`
        : "";
      const url = `${CFRADAR_BASE_URL}/bgp/hijacks/events?limit=100&dateRange=${dateRange}&format=JSON${locationParam}`;
      const data = await this.fetchRadar<CfBgpHijacksResponse>(
        url,
        headers,
        context,
      );

      const asnNamesByAsn = new Map<number, string>(
        data.result.asn_info.map((info) => [info.asn, info.org_name]),
      );

      return data.result.events.map((event) => {
        const asnName = asnNamesByAsn.get(event.hijacker_asn);
        return {
          type: RECORD_TYPE_INTERNET_ANOMALY,
          timestamp: now,
          source: CFRADAR_INTEGRATION_ID,
          entityKey: `cfradar:bgp:${event.id}`,
          data: {
            anomalyType: "bgp_hijack" as const,
            startDate: event.min_hijack_ts,
            ...(event.max_hijack_ts != null
              ? { endDate: event.max_hijack_ts }
              : {}),
            asn: event.hijacker_asn,
            ...(asnName !== undefined ? { asnName } : {}),
          },
        };
      });
    }

    throw new Error(
      `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
    );
  }

  private async fetchRadar<T>(
    url: string,
    headers: Record<string, string>,
    context: RuntimeContext,
  ): Promise<T> {
    const response = await fetch(url, {
      headers,
      signal: context.signal ?? null,
    });

    if (response.status === 401 || response.status === 403) {
      throw new PluginAuthError("Cloudflare Radar token is invalid.");
    }
    if (response.status === 429) {
      throw new RateLimitError("Cloudflare Radar rate limit reached.", 60_000);
    }
    if (!response.ok) {
      throw new TransientError(
        `Cloudflare Radar API returned HTTP ${response.status}.`,
      );
    }

    return (await response.json()) as T;
  }
}
