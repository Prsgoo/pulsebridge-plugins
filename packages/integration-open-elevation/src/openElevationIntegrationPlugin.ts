import {
  PluginInputError,
  PluginKinds,
  RateLimitError,
  TransientError,
  type ActionResult,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";
import { z, type ZodType } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPEN_ELEVATION_INTEGRATION_ID =
  "@prsgoo/integration-open-elevation";
export const RECORD_TYPE_ELEVATION = "elevation.point";
export const ACTION_LOOKUP = "lookup";
export const DEFAULT_BASE_URL = "https://api.open-elevation.com";

const LOOKUP_PATH = "/api/v1/lookup";

// Guards against unbounded request bodies; the public instance struggles with
// very large batches. Self-hosters can fork this constant if needed.
const MAX_LOCATIONS = 100;

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export const openElevationConfigSchema = z.object({
  /**
   * Base URL of the Open-Elevation instance. Defaults to the public API; point
   * it at a self-hosted instance to avoid the public endpoint's rate limits.
   */
  baseUrl: z.string().url().default(DEFAULT_BASE_URL),
});

export type OpenElevationConfig = z.infer<typeof openElevationConfigSchema>;

// ---------------------------------------------------------------------------
// Action payload schema — validated inside invoke(); a parse failure is a
// caller fault (PluginInputError), never a plugin-health event.
// ---------------------------------------------------------------------------

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const lookupPayloadSchema = z.object({
  locations: z
    .array(locationSchema)
    .min(1, "At least one location is required.")
    .max(MAX_LOCATIONS, `At most ${MAX_LOCATIONS} locations per request.`),
});

export type LookupPayload = z.infer<typeof lookupPayloadSchema>;

export interface ElevationPointData {
  latitude: number;
  longitude: number;
  /** Terrain elevation in meters above sea level, as reported by the dataset. */
  elevationMeters: number;
}

interface OpenElevationResponse {
  results: ReadonlyArray<{
    latitude: number;
    longitude: number;
    elevation: number;
  }>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class OpenElevationIntegrationPlugin implements IntegrationPlugin<OpenElevationConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: OPEN_ELEVATION_INTEGRATION_ID,
    name: "Open-Elevation Integration",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    // Action-only: elevation is a request/response lookup, nothing to poll.
    operations: [],
    actions: [
      {
        id: ACTION_LOOKUP,
        name: "Lookup Elevation",
        description:
          "Look up terrain elevation (meters) for a batch of latitude/longitude coordinates.",
        producesRecordType: RECORD_TYPE_ELEVATION,
      },
    ],
    auth: { type: "none" },
  };

  readonly configSchema = openElevationConfigSchema;

  private config: OpenElevationConfig = { baseUrl: DEFAULT_BASE_URL };

  configure(config: OpenElevationConfig): void {
    this.config = config;
  }

  // ── Pull ──────────────────────────────────────────────────────────────────
  // No operations are declared, so the scheduler never calls this. Implemented
  // defensively to satisfy the IntegrationPlugin contract.
  execute(operationId: string): Promise<ReadonlyArray<PulseRecord>> {
    throw new Error(
      `Operation '${operationId}' is not supported by '${this.manifest.id}' (action-only plugin).`,
    );
  }

  // ── Push-out (actions) ──────────────────────────────────────────────────────
  async invoke(
    actionId: string,
    context: RuntimeContext,
    payload?: unknown,
  ): Promise<ActionResult> {
    if (actionId !== ACTION_LOOKUP) {
      // Unknown action is a caller fault, not an upstream failure.
      throw new PluginInputError(
        `Action '${actionId}' is not supported by '${this.manifest.id}'.`,
      );
    }
    return this.lookup(context, payload);
  }

  private async lookup(
    context: RuntimeContext,
    payload: unknown,
  ): Promise<ActionResult> {
    const { locations } = parsePayload(lookupPayloadSchema, payload);
    const response = await this.request(context, { locations });
    const points: ElevationPointData[] = response.results.map((result) => ({
      latitude: result.latitude,
      longitude: result.longitude,
      elevationMeters: result.elevation,
    }));
    return {
      data: points,
      records: points.map((point) => ({
        type: RECORD_TYPE_ELEVATION,
        timestamp: context.now().toISOString(),
        source: OPEN_ELEVATION_INTEGRATION_ID,
        entityKey: `elevation:${point.latitude},${point.longitude}`,
        data: point,
      })),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  private async request(
    context: RuntimeContext,
    body: LookupPayload,
  ): Promise<OpenElevationResponse> {
    const url = `${this.config.baseUrl}${LOOKUP_PATH}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: context.signal ?? null,
    });

    if (response.status === 400) {
      throw new PluginInputError(
        "Open-Elevation rejected the request (HTTP 400).",
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(
        "Open-Elevation rate limit reached.",
        retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : undefined,
      );
    }
    if (!response.ok) {
      throw new TransientError(
        `Open-Elevation returned HTTP ${response.status}.`,
      );
    }
    return (await response.json()) as OpenElevationResponse;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePayload<T>(schema: ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new PluginInputError(
      result.error.issues[0]?.message ?? "Invalid payload.",
    );
  }
  return result.data;
}
