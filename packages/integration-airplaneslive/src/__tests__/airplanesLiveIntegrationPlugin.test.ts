import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  AirplanesLiveIntegrationPlugin,
  AIRPLANES_LIVE_INTEGRATION_ID,
  RECORD_TYPE_FLIGHT_POSITION,
  airplanesLiveConfigSchema,
} from "../airplanesLiveIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(signal?: AbortSignal) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-06-01T12:00:00Z"),
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

function makeAircraft(overrides: Record<string, unknown> = {}) {
  return {
    hex: "a1b2c3",
    flight: "UAL123 ",
    lat: 37.5,
    lon: -122.0,
    alt_baro: 35000,
    gs: 450,
    track: 270,
    seen_pos: 2,
    ...overrides,
  };
}

function makeResponse(
  ac: unknown[],
  now = 1717243200,
): { ac: unknown[]; now: number; total: number } {
  return { ac, now, total: ac.length };
}

describe("AirplanesLiveIntegrationPlugin", () => {
  let plugin: AirplanesLiveIntegrationPlugin;

  beforeEach(() => {
    plugin = new AirplanesLiveIntegrationPlugin();
    plugin.configure({});
    vi.clearAllMocks();
  });

  it("should return flight records on 200", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft()])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_FLIGHT_POSITION);
    expect(records[0]?.source).toBe(AIRPLANES_LIVE_INTEGRATION_ID);
    expect(records[0]?.entityKey).toBe("icao24:a1b2c3");
  });

  it("should skip aircraft with no lat", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(
        makeResponse([
          makeAircraft({ lat: undefined }),
          makeAircraft({ hex: "aabbcc" }),
        ]),
      ),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.entityKey).toBe("icao24:aabbcc");
  });

  it("should skip aircraft with no lon", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(
        makeResponse([
          makeAircraft({ lon: undefined }),
          makeAircraft({ hex: "aabbcc" }),
        ]),
      ),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.entityKey).toBe("icao24:aabbcc");
  });

  it("should convert alt_baro feet to metres", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ alt_baro: 10000 })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.altitudeM).toBeCloseTo(3048, 5);
    expect(records[0]?.data.onGround).toBe(false);
  });

  it("should set onGround=true and altitudeM=0 when alt_baro is 'ground'", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ alt_baro: "ground" })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.onGround).toBe(true);
    expect(records[0]?.data.altitudeM).toBe(0);
  });

  it("should set altitudeM=null when alt_baro is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ alt_baro: undefined })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.altitudeM).toBeNull();
    expect(records[0]?.data.onGround).toBe(false);
  });

  it("should trim callsign", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ flight: "UAL123  " })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBe("UAL123");
  });

  it("should return null callsign when flight is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ flight: undefined })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should return null callsign when flight is empty after trim", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ flight: "   " })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should pass speedKt directly from gs", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ gs: 480 })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBe(480);
  });

  it("should set speedKt=null when gs is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ gs: undefined })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBeNull();
  });

  it("should map heading from track", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ track: 90 })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.heading).toBe(90);
  });

  it("should set heading=null when track is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ track: undefined })])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.heading).toBeNull();
  });

  it("should send bounding box query params when configured", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(makeResponse([])));

    plugin.configure({
      boundingBox: { minLat: 10, maxLat: 50, minLon: -30, maxLon: 40 },
    });

    await plugin.execute("fetch-flights", makeContext() as never);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("lat_min=10");
    expect(url).toContain("lat_max=50");
    expect(url).toContain("lon_min=-30");
    expect(url).toContain("lon_max=40");
  });

  it("should NOT send bounding box params when not configured", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(makeResponse([])));

    await plugin.execute("fetch-flights", makeContext() as never);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://api.airplanes.live/v2/aircraft");
    expect(url).not.toContain("lat_min");
  });

  it("should pass abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(makeResponse([])));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-flights",
      makeContext(controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should report a 60s retry delay on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should throw TransientError on 503", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should throw on unknown operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should return empty array when ac is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([])),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should derive lastContact from response.now and seen_pos", async () => {
    // now=1717243200 (unix seconds), seen_pos=5 → lastContact = (1717243200 - 5) * 1000 ms
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(makeResponse([makeAircraft({ seen_pos: 5 })], 1717243200)),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    const expectedMs = (1717243200 - 5) * 1000;
    expect(records[0]?.data.lastContact).toBe(
      new Date(expectedMs).toISOString(),
    );
  });

  it("should use now directly when seen_pos is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(
        makeResponse([makeAircraft({ seen_pos: undefined })], 1717243200),
      ),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.lastContact).toBe(
      new Date(1717243200 * 1000).toISOString(),
    );
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-airplaneslive",
      name: "Airplanes.live",
      version: "0.1.0-beta.1",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-flights",
          name: "Fetch Flights",
          recordType: "flight.position",
        },
      ],
      auth: { type: "none" },
      polling: {
        defaultIntervalMs: 30_000,
        minIntervalMs: 10_000,
      },
      rateLimit: { requestsPerMinute: 10, maxConcurrentRequests: 1 },
    });
  });

  it("should accept a valid config with a bounding box", () => {
    expect(() =>
      airplanesLiveConfigSchema.parse({
        boundingBox: { minLat: 10, maxLat: 50, minLon: -30, maxLon: 40 },
      }),
    ).not.toThrow();
  });

  it("should accept a config with no bounding box", () => {
    expect(() => airplanesLiveConfigSchema.parse({})).not.toThrow();
  });

  it("should reject a bounding box with out-of-range latitude", () => {
    expect(() =>
      airplanesLiveConfigSchema.parse({
        boundingBox: { minLat: -91, maxLat: 50, minLon: 0, maxLon: 10 },
      }),
    ).toThrow();
  });

  it("should reject a bounding box with out-of-range longitude", () => {
    expect(() =>
      airplanesLiveConfigSchema.parse({
        boundingBox: { minLat: 0, maxLat: 10, minLon: -181, maxLon: 10 },
      }),
    ).toThrow();
  });
});
