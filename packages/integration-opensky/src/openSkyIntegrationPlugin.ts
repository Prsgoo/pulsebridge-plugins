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

export const OPENSKY_INTEGRATION_ID = "@prsgoo/integration-opensky";
export const RECORD_TYPE_FLIGHT_POSITION = "flight.position";

const OPENSKY_API_URL = "https://opensky-network.org/api/states/all";
const MS_PER_S = 1000;
const MPS_TO_KNOTS = 1.94384;

export const openSkyConfigSchema = z.object({
  boundingBox: z
    .object({
      minLat: z.number().min(-90).max(90),
      maxLat: z.number().min(-90).max(90),
      minLon: z.number().min(-180).max(180),
      maxLon: z.number().min(-180).max(180),
    })
    .optional(),
});

export type OpenSkyConfig = z.infer<typeof openSkyConfigSchema>;

export interface FlightPositionData {
  icao24: string;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  speedKt: number | null;
  heading: number | null;
  onGround: boolean;
  lastContact: string;
}

interface OpenSkyResponse {
  time: number;
  states: Array<
    [
      string,
      string | null,
      string,
      number | null,
      number,
      number | null,
      number | null,
      number | null,
      boolean,
      number | null,
      number | null,
      ...unknown[],
    ]
  > | null;
}

export class OpenSkyIntegrationPlugin implements IntegrationPlugin<OpenSkyConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: OPENSKY_INTEGRATION_ID,
    name: "OpenSky Network",
    version: "0.1.0-beta.1",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-flights",
        name: "Fetch Flights",
        recordType: RECORD_TYPE_FLIGHT_POSITION,
      },
    ],
    auth: {
      type: "basic",
      secrets: [
        { key: "OPENSKY_USERNAME", required: false },
        { key: "OPENSKY_PASSWORD", required: false },
      ],
    },
    polling: {
      defaultIntervalMs: 30_000,
      minIntervalMs: 10_000,
    },
    rateLimit: {
      requestsPerMinute: 4,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = openSkyConfigSchema;

  private config: OpenSkyConfig = {};

  configure(config: OpenSkyConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<FlightPositionData>>> {
    if (operationId !== "fetch-flights") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const url = this.buildUrl();
    const headers: Record<string, string> = {};

    const username = context.secrets.get("OPENSKY_USERNAME");
    const password = context.secrets.get("OPENSKY_PASSWORD");
    if (username && password) {
      headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
    }

    const response = await fetch(url, {
      headers,
      signal: context.signal ?? null,
    });

    if (response.status === 429) {
      throw new RateLimitError("OpenSky rate limit reached.", 60_000);
    }

    if (!response.ok) {
      throw new TransientError(`OpenSky API returned HTTP ${response.status}.`);
    }

    const data = (await response.json()) as OpenSkyResponse;

    if (!data.states) {
      return [];
    }

    const now = context.now().toISOString();

    return data.states.flatMap((state) => {
      const longitude = state[5];
      const latitude = state[6];

      if (latitude === null || longitude === null) return [];

      const icao24 = state[0];
      const rawCallsign = state[1];
      const lastContactUnix = state[4];
      const baroAltitude = state[7];
      const onGround = state[8];
      const velocity = state[9];
      const trueTrack = state[10];

      return [
        {
          type: RECORD_TYPE_FLIGHT_POSITION,
          timestamp: now,
          source: OPENSKY_INTEGRATION_ID,
          entityKey: `icao24:${icao24}`,
          data: {
            icao24,
            callsign: rawCallsign ? rawCallsign.trim() || null : null,
            latitude,
            longitude,
            altitudeM: baroAltitude,
            speedKt: velocity !== null ? velocity * MPS_TO_KNOTS : null,
            heading: trueTrack,
            onGround,
            lastContact: new Date(lastContactUnix * MS_PER_S).toISOString(),
          },
        },
      ];
    });
  }

  private buildUrl(): string {
    const bb = this.config.boundingBox;
    if (!bb) return OPENSKY_API_URL;
    const params = new URLSearchParams({
      lamin: String(bb.minLat),
      lomin: String(bb.minLon),
      lamax: String(bb.maxLat),
      lomax: String(bb.maxLon),
    });
    return `${OPENSKY_API_URL}?${params.toString()}`;
  }
}
