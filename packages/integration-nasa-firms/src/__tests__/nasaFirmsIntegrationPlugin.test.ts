import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  NasaFirmsIntegrationPlugin,
  NASA_FIRMS_INTEGRATION_ID,
  RECORD_TYPE_WILDFIRE_EVENT,
  nasaFirmsConfigSchema,
} from "../nasaFirmsIntegrationPlugin.js";

const VIIRS_HEADER =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";

const MODIS_HEADER =
  "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight";

const VIIRS_ROW =
  "34.5,-118.2,330.1,0.39,0.36,2024-07-15,9,N20,VIIRS,nominal,2.0NRT,290.5,12.5,D";

const MODIS_ROW =
  "34.5,-118.2,325.0,1.0,1.0,2024-07-15,9,Terra,MODIS,75,6.1NRT,295.0,8.3,D";

function makeOkResponse(csvText: string): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(csvText),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(""),
    headers: { get: () => null },
  } as unknown as Response;
}

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(
  secretsMap: Record<string, string> = { FIRMS_MAP_KEY: "test-key" },
) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-07-15T12:00:00Z"),
    secrets: {
      get: (key: string) => secretsMap[key],
      has: (key: string) => key in secretsMap,
    },
    signal: undefined,
  };
}

describe("NasaFirmsIntegrationPlugin", () => {
  let plugin: NasaFirmsIntegrationPlugin;

  beforeEach(() => {
    plugin = new NasaFirmsIntegrationPlugin();
    plugin.configure(nasaFirmsConfigSchema.parse({}));
    vi.clearAllMocks();
  });

  it("should return wildfire.event records from a valid VIIRS CSV response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${VIIRS_ROW}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_WILDFIRE_EVENT);
  });

  it("should map all WildfireEventData fields correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${VIIRS_ROW}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_WILDFIRE_EVENT,
      source: NASA_FIRMS_INTEGRATION_ID,
      entityKey: "firms:34.5,-118.2,2024-07-15,0009",
      data: {
        latitude: 34.5,
        longitude: -118.2,
        brightness: 330.1,
        frp: 12.5,
        confidence: "nominal",
        instrument: "VIIRS",
        acquisitionDate: "2024-07-15",
        acquisitionTime: "0009",
        satellite: "N20",
      },
    });
  });

  it("should construct the correct URL with MAP_KEY, source, bounding box, and dayRange", async () => {
    plugin.configure(
      nasaFirmsConfigSchema.parse({
        source: "VIIRS_NOAA20_NRT",
        dayRange: 3,
        boundingBox: { minLat: 30, maxLat: 40, minLon: -120, maxLon: -110 },
      }),
    );
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(`${VIIRS_HEADER}`));

    await plugin.execute("fetch-fires", makeContext() as never);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toBe(
      "https://firms.modaps.eosdis.nasa.gov/api/area/csv/test-key/VIIRS_NOAA20_NRT/-120,30,-110,40/3",
    );
  });

  it("should use world bbox when no boundingBox is configured", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(`${VIIRS_HEADER}`));

    await plugin.execute("fetch-fires", makeContext() as never);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("-180,-90,180,90");
  });

  it("should apply the configured bounding box in the URL", async () => {
    plugin.configure(
      nasaFirmsConfigSchema.parse({
        boundingBox: { minLat: 25, maxLat: 50, minLon: -130, maxLon: -60 },
      }),
    );
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(`${VIIRS_HEADER}`));

    await plugin.execute("fetch-fires", makeContext() as never);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("-130,25,-60,50");
  });

  it("should pad acq_time to 4 digits in entityKey", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${VIIRS_ROW}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records[0]?.entityKey).toContain(",0009");
  });

  it("should produce entityKey in format firms:<lat>,<lon>,<date>,<time>", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${VIIRS_ROW}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records[0]?.entityKey).toBe("firms:34.5,-118.2,2024-07-15,0009");
  });

  it("should throw TransientError when FIRMS_MAP_KEY secret is missing", async () => {
    await expect(
      plugin.execute("fetch-fires", makeContext({}) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include a descriptive message when FIRMS_MAP_KEY is missing", async () => {
    await expect(
      plugin.execute("fetch-fires", makeContext({}) as never),
    ).rejects.toThrow("FIRMS_MAP_KEY secret is not configured.");
  });

  it("should throw RateLimitError on HTTP 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-fires", makeContext() as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should throw TransientError on other non-200 responses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-fires", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the non-ok error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-fires", makeContext() as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should skip rows where latitude is not a number", async () => {
    const badRow =
      "invalid,-118.2,330.1,0.39,0.36,2024-07-15,9,N20,VIIRS,nominal,2.0NRT,290.5,12.5,D";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${badRow}\n${VIIRS_ROW}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records).toHaveLength(1);
  });

  it("should skip rows where longitude is not a number", async () => {
    const badRow =
      "34.5,invalid,330.1,0.39,0.36,2024-07-15,9,N20,VIIRS,nominal,2.0NRT,290.5,12.5,D";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}\n${badRow}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should return empty array for response with only a header row", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${VIIRS_HEADER}`),
    );

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(`${VIIRS_HEADER}`));
    const controller = new AbortController();
    const ctx = { ...makeContext(), signal: controller.signal };

    await plugin.execute("fetch-fires", ctx as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass null signal when context has no signal", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(`${VIIRS_HEADER}`));

    await plugin.execute("fetch-fires", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should throw on unknown operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest id", () => {
    expect(plugin.manifest.id).toBe("@prsgoo/integration-nasa-firms");
  });

  it("should expose version 0.1.0-beta.1 in the manifest", () => {
    expect(plugin.manifest.version).toBe("0.1.0-beta.1");
  });

  it("should expose PluginKinds.INTEGRATION as the manifest kind", () => {
    expect(plugin.manifest.kind).toBe(PluginKinds.INTEGRATION);
  });

  it("should expose FIRMS_MAP_KEY in auth secrets", () => {
    expect(plugin.manifest.auth.secrets?.[0]?.key).toBe("FIRMS_MAP_KEY");
  });

  it("should expose wildfire.event as the operations recordType", () => {
    expect(plugin.manifest.operations[0]?.recordType).toBe(
      RECORD_TYPE_WILDFIRE_EVENT,
    );
  });

  it("should default dayRange to 1", () => {
    expect(nasaFirmsConfigSchema.parse({}).dayRange).toBe(1);
  });

  it("should default source to VIIRS_SNPP_NRT", () => {
    expect(nasaFirmsConfigSchema.parse({}).source).toBe("VIIRS_SNPP_NRT");
  });

  it("should parse MODIS brightness column correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(`${MODIS_HEADER}\n${MODIS_ROW}`),
    );
    plugin.configure(nasaFirmsConfigSchema.parse({ source: "MODIS_NRT" }));

    const records = await plugin.execute("fetch-fires", makeContext() as never);

    expect(records[0]?.data.brightness).toBe(325.0);
    expect(records[0]?.data.instrument).toBe("MODIS");
  });
});
