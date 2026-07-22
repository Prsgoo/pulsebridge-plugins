import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  AdsbFiIntegrationPlugin,
  ADSBFI_INTEGRATION_ID,
  RECORD_TYPE_FLIGHT_POSITION,
  adsbFiConfigSchema,
} from "../adsbFiIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(signal?: AbortSignal) {
  return {
    logger: mockLogger,
    now: () => new Date("2024-06-01T10:00:00Z"),
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

function makeResponse(aircraft: unknown[], now = 1717228800) {
  return makeOkResponse({ aircraft, now });
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

describe("AdsbFiIntegrationPlugin", () => {
  let plugin: AdsbFiIntegrationPlugin;

  beforeEach(() => {
    plugin = new AdsbFiIntegrationPlugin();
    plugin.configure({ lat: 51.5, lon: -0.12, dist: 500 });
    vi.clearAllMocks();
  });

  it("should return flight records on 200", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft()]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_FLIGHT_POSITION);
    expect(records[0]?.source).toBe(ADSBFI_INTEGRATION_ID);
    expect(records[0]?.entityKey).toBe("icao24:a1b2c3");
  });

  it("should skip aircraft with no lat", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([
        makeAircraft({ lat: undefined }),
        makeAircraft({ hex: "def456" }),
      ]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.data.icao24).toBe("def456");
  });

  it("should skip aircraft with no lon", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([
        makeAircraft({ lon: undefined }),
        makeAircraft({ hex: "def456" }),
      ]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.data.icao24).toBe("def456");
  });

  it("should convert alt_baro feet to metres correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ alt_baro: 10000 })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.altitudeM).toBeCloseTo(3048, 0);
    expect(records[0]?.data.onGround).toBe(false);
  });

  it("should set onGround=true and altitudeM=0 when alt_baro is 'ground'", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ alt_baro: "ground" })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.onGround).toBe(true);
    expect(records[0]?.data.altitudeM).toBe(0);
  });

  it("should set altitudeM=null when alt_baro is absent", async () => {
    const ac = makeAircraft();
    delete (ac as Record<string, unknown>).alt_baro;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeResponse([ac]));

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.altitudeM).toBeNull();
    expect(records[0]?.data.onGround).toBe(false);
  });

  it("should trim callsign whitespace", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ flight: "UAL123  " })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBe("UAL123");
  });

  it("should return null callsign when flight field is absent", async () => {
    const ac = makeAircraft();
    delete (ac as Record<string, unknown>).flight;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeResponse([ac]));

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should return null callsign when flight field is empty string", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ flight: "   " })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should pass speedKt through directly without conversion", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ gs: 320 })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBe(320);
  });

  it("should map heading from track field", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ track: 180 })]),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.heading).toBe(180);
  });

  it("should build URL from lat, lon, dist path params", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse([]));

    plugin.configure({ lat: 30, lon: -100, dist: 250 });
    await plugin.execute("fetch-flights", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://opendata.adsb.fi/api/v2/lat/30/lon/-100/dist/250",
    );
  });

  it("should throw when lat, lon, or dist are not configured", async () => {
    plugin.configure({});

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toThrow("lat, lon, and dist");
  });

  it("should pass abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse([]));
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

  it("should return empty array when aircraft is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeResponse([]));

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should derive lastContact from response.now and seen_pos", async () => {
    // now=1717228800 (seconds), seen_pos=10 → lastContact = (1717228800 - 10) * 1000 ms
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([makeAircraft({ seen_pos: 10 })], 1717228800),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.lastContact).toBe(
      new Date((1717228800 - 10) * 1000).toISOString(),
    );
  });

  it("should use now as lastContact when seen_pos is absent", async () => {
    const ac = makeAircraft();
    delete (ac as Record<string, unknown>).seen_pos;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse([ac], 1717228800),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.lastContact).toBe(
      new Date(1717228800 * 1000).toISOString(),
    );
  });

  it("should expose expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-adsbfi",
      name: "adsb.fi",
      version: "0.1.0-beta.2",
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

  it("should accept config with no location", () => {
    expect(() => adsbFiConfigSchema.parse({})).not.toThrow();
  });

  it("should accept a valid lat/lon/dist config", () => {
    expect(() =>
      adsbFiConfigSchema.parse({ lat: 51.5, lon: -0.12, dist: 500 }),
    ).not.toThrow();
  });

  it("should reject lat out of range", () => {
    expect(() =>
      adsbFiConfigSchema.parse({ lat: -91, lon: 0, dist: 250 }),
    ).toThrow();
  });

  it("should reject lon out of range", () => {
    expect(() =>
      adsbFiConfigSchema.parse({ lat: 0, lon: -181, dist: 250 }),
    ).toThrow();
  });

  it("should reject non-positive dist", () => {
    expect(() =>
      adsbFiConfigSchema.parse({ lat: 51.5, lon: -0.12, dist: -10 }),
    ).toThrow();
  });

  it("should set speedKt to null when gs is absent", async () => {
    const ac = makeAircraft();
    delete (ac as Record<string, unknown>).gs;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeResponse([ac]));

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBeNull();
  });

  it("should set heading to null when track is absent", async () => {
    const ac = makeAircraft();
    delete (ac as Record<string, unknown>).track;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeResponse([ac]));

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.heading).toBeNull();
  });
});
