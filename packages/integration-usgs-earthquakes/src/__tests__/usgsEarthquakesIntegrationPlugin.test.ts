import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  UsgsEarthquakesIntegrationPlugin,
  RECORD_TYPE_SEISMIC_EVENT,
  usgsConfigSchema,
} from "../usgsEarthquakesIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(signal?: AbortSignal) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
    signal,
  };
}

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeFeature(id: string, mag: number) {
  return {
    id,
    properties: {
      mag,
      magType: "ml",
      place: "10km NW of Test City",
      time: 1705316400000,
      sig: 123,
      tsunami: 0,
      alert: null,
      status: "reviewed",
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    },
    geometry: { coordinates: [-122.0, 37.5, 10.0] as [number, number, number] },
  };
}

describe("UsgsEarthquakesIntegrationPlugin", () => {
  let plugin: UsgsEarthquakesIntegrationPlugin;

  beforeEach(() => {
    plugin = new UsgsEarthquakesIntegrationPlugin();
    plugin.configure({ minMagnitude: 2.5 });
    vi.clearAllMocks();
  });

  it("should return seismic event records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [makeFeature("us2024abc1", 3.5)] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_SEISMIC_EVENT);
    expect(records[0]?.entityKey).toBe("usgs:us2024abc1");
    expect(records[0]?.data.magnitude).toBe(3.5);
    expect(records[0]?.data.tsunami).toBe(false);
  });

  it("should filter out earthquakes below minMagnitude", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        features: [
          makeFeature("us2024abc1", 3.5),
          makeFeature("us2024abc2", 1.0),
          makeFeature("us2024abc3", 2.4),
        ],
      }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.data.magnitude).toBe(3.5);
  });

  it("should return empty array when no earthquakes meet threshold", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-earthquakes", makeContext() as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-earthquakes", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should map every field of a feature into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [makeFeature("us2024abc1", 3.5)] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_SEISMIC_EVENT,
      source: "@prsgoo/integration-usgs-earthquakes",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "usgs:us2024abc1",
      data: {
        magnitude: 3.5,
        magnitudeType: "ml",
        place: "10km NW of Test City",
        depth: 10.0,
        latitude: 37.5,
        longitude: -122.0,
        significance: 123,
        tsunami: false,
        alert: null,
        status: "reviewed",
        eventTime: "2024-01-15T11:00:00.000Z",
      },
    });
  });

  it("should include an earthquake exactly at the magnitude threshold", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [makeFeature("us2024edge", 2.5)] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
  });

  it("should fall back to defaults for null magType, place and alert", async () => {
    const feature = makeFeature("us2024null", 3.5);
    const props = feature.properties as {
      magType: string | null;
      place: string | null;
      alert: string | null;
    };
    props.magType = null;
    props.place = null;
    props.alert = null;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [feature] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records[0]?.data.magnitudeType).toBe("unknown");
    expect(records[0]?.data.place).toBe("unknown");
  });

  it("should treat tsunami flag 1 as true", async () => {
    const feature = makeFeature("us2024tsunami", 5.0);
    feature.properties.tsunami = 1;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [feature] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records[0]?.data.tsunami).toBe(true);
  });

  it("should honour a reconfigured minimum magnitude", async () => {
    plugin.configure({ minMagnitude: 5 });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [makeFeature("us2024abc1", 3.5)] }),
    );

    const records = await plugin.execute(
      "fetch-earthquakes",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should fetch the USGS all-day feed and forward the abort signal", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ features: [] }));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-earthquakes",
      makeContext(controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ features: [] }));

    await plugin.execute("fetch-earthquakes", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should log the configured minimum magnitude", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ features: [] }),
    );

    await plugin.execute("fetch-earthquakes", makeContext() as never);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Fetching USGS earthquake feed.",
      { minMagnitude: 2.5 },
    );
  });

  it("should report a 60s retry delay on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-earthquakes", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-earthquakes", makeContext() as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-usgs-earthquakes",
      name: "USGS Earthquakes",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-earthquakes",
          name: "Fetch Earthquakes",
          recordType: "seismic.event",
        },
      ],
      auth: { type: "none" },
      polling: {
        defaultIntervalMs: 300_000,
        minIntervalMs: 60_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 30, maxConcurrentRequests: 1 },
    });
  });

  it("should default the minimum magnitude to 2.5", () => {
    expect(usgsConfigSchema.parse({}).minMagnitude).toBe(2.5);
  });

  it("should reject a negative minimum magnitude", () => {
    expect(() => usgsConfigSchema.parse({ minMagnitude: -1 })).toThrow();
  });

  it("should reject a minimum magnitude above 10", () => {
    expect(() => usgsConfigSchema.parse({ minMagnitude: 11 })).toThrow();
  });
});
