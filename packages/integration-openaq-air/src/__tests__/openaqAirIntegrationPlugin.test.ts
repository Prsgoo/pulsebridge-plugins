import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  OpenaqAirIntegrationPlugin,
  RECORD_TYPE_AIR_QUALITY,
  openaqConfigSchema,
} from "../openaqAirIntegrationPlugin.js";

const TEST_KEY = "demo-value";
const withKey = { OPENAQ_API_KEY: TEST_KEY };

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(
  secrets: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: {
      get: (k: string) => secrets[k],
      has: (k: string) => k in secrets,
    },
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

const openaqLocation = {
  id: 5753480,
  name: "London Westminster",
  coordinates: { latitude: 51.4969, longitude: -0.1358 },
  country: { code: "GB" },
  sensors: [
    { id: 101, parameter: { name: "pm25", units: "µg/m³" } },
    { id: 102, parameter: { name: "no2", units: "µg/m³" } },
  ],
};

const openaqLatest = {
  results: [
    {
      value: 12.5,
      sensorsId: 101,
      datetime: { utc: "2024-01-15T11:00:00Z" },
    },
  ],
};

function mockLocationThenLatest(
  location: unknown = openaqLocation,
  latest: unknown = openaqLatest,
) {
  return vi
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(makeOkResponse({ results: [location] }))
    .mockResolvedValueOnce(makeOkResponse(latest));
}

describe("OpenaqAirIntegrationPlugin", () => {
  let plugin: OpenaqAirIntegrationPlugin;

  beforeEach(() => {
    plugin = new OpenaqAirIntegrationPlugin();
    plugin.configure({ locations: [5753480] });
    vi.clearAllMocks();
  });

  it("should return air quality records for sensors with latest data", async () => {
    mockLocationThenLatest();

    const records = await plugin.execute(
      "fetch-measurements",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_AIR_QUALITY);
    expect(records[0]?.entityKey).toBe("openaq:5753480:pm25");
    expect(records[0]?.data.value).toBe(12.5);
    expect(records[0]?.data.latitude).toBe(51.4969);
    expect(records[0]?.data.country).toBe("GB");
  });

  it("should map every measurement field into the record", async () => {
    mockLocationThenLatest();

    const records = await plugin.execute(
      "fetch-measurements",
      makeContext(withKey) as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_AIR_QUALITY,
      source: "@prsgoo/integration-openaq-air",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "openaq:5753480:pm25",
      data: {
        locationId: 5753480,
        locationName: "London Westminster",
        parameter: "pm25",
        value: 12.5,
        unit: "µg/m³",
        latitude: 51.4969,
        longitude: -0.1358,
        country: "GB",
      },
    });
  });

  it("should request the location metadata endpoint with the API key header", async () => {
    const fetchSpy = mockLocationThenLatest(openaqLocation, { results: [] });

    await plugin.execute("fetch-measurements", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.openaq.org/v3/locations/5753480",
    );
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["X-API-Key"]).toBe(TEST_KEY);
  });

  it("should request the latest endpoint after the metadata endpoint", async () => {
    const fetchSpy = mockLocationThenLatest(openaqLocation, { results: [] });

    await plugin.execute("fetch-measurements", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "https://api.openaq.org/v3/locations/5753480/latest",
    );
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = mockLocationThenLatest(openaqLocation, { results: [] });
    const controller = new AbortController();

    await plugin.execute(
      "fetch-measurements",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = mockLocationThenLatest(openaqLocation, { results: [] });

    await plugin.execute("fetch-measurements", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should skip latest values with no matching sensor", async () => {
    mockLocationThenLatest(openaqLocation, {
      results: [
        { value: 5, sensorsId: 999, datetime: { utc: "2024-01-15T11:00:00Z" } },
      ],
    });

    const records = await plugin.execute(
      "fetch-measurements",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should skip a location whose metadata has no results", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ results: [] }),
    );

    const records = await plugin.execute(
      "fetch-measurements",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should omit coordinates and country when not present", async () => {
    const locationNoCoords = {
      ...openaqLocation,
      coordinates: undefined,
      country: undefined,
    };
    mockLocationThenLatest(locationNoCoords, openaqLatest);

    const records = await plugin.execute(
      "fetch-measurements",
      makeContext(withKey) as never,
    );

    expect(Object.keys(records[0]?.data ?? {})).not.toContain("latitude");
    expect(Object.keys(records[0]?.data ?? {})).not.toContain("longitude");
    expect(Object.keys(records[0]?.data ?? {})).not.toContain("country");
  });

  it("should throw PluginAuthError when OPENAQ_API_KEY is missing", async () => {
    await expect(
      plugin.execute("fetch-measurements", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should name the missing secret in the auth error", async () => {
    await expect(
      plugin.execute("fetch-measurements", makeContext() as never),
    ).rejects.toThrow(/OPENAQ_API_KEY/);
  });

  it("should throw PluginAuthError on 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should describe an invalid key on 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toThrow(/invalid/i);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should report a 60s retry delay on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should mention the rate limit in the 429 error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toThrow(/rate limit/i);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-measurements", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-openaq-air",
      name: "OpenAQ Air Quality",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-measurements",
          name: "Fetch Measurements",
          recordType: "air.quality",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [{ key: "OPENAQ_API_KEY", required: true }],
      },
      polling: {
        defaultIntervalMs: 1_800_000,
        minIntervalMs: 600_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 60, maxConcurrentRequests: 1 },
    });
  });

  it("should accept a list of positive integer location ids", () => {
    expect(openaqConfigSchema.parse({ locations: [123] }).locations).toEqual([
      123,
    ]);
  });

  it("should reject an empty locations list", () => {
    expect(() => openaqConfigSchema.parse({ locations: [] })).toThrow();
  });

  it("should reject non-positive location ids", () => {
    expect(() => openaqConfigSchema.parse({ locations: [0] })).toThrow();
  });

  it("should reject non-integer location ids", () => {
    expect(() => openaqConfigSchema.parse({ locations: [1.5] })).toThrow();
  });
});
