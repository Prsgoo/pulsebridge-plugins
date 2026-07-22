import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  OpenSkyIntegrationPlugin,
  OPENSKY_INTEGRATION_ID,
  RECORD_TYPE_FLIGHT_POSITION,
  openSkyConfigSchema,
} from "../openSkyIntegrationPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(overrides?: {
  signal?: AbortSignal;
  username?: string;
  password?: string;
}) {
  const secrets: Record<string, string> = {};
  if (overrides?.username) secrets["OPENSKY_USERNAME"] = overrides.username;
  if (overrides?.password) secrets["OPENSKY_PASSWORD"] = overrides.password;

  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: {
      get: (key: string) => secrets[key],
      has: (key: string) => key in secrets,
    },
    signal: overrides?.signal,
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

function makeState(
  overrides?: Partial<{
    icao24: string;
    callsign: string | null;
    lastContact: number;
    longitude: number | null;
    latitude: number | null;
    baroAltitude: number | null;
    onGround: boolean;
    velocity: number | null;
    trueTrack: number | null;
  }>,
): [
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
] {
  return [
    overrides?.icao24 ?? "a1b2c3",
    overrides?.callsign !== undefined ? overrides.callsign : "BAW123  ",
    "United Kingdom",
    1705316390,
    overrides?.lastContact ?? 1705316400,
    overrides?.longitude !== undefined ? overrides.longitude : -0.4619,
    overrides?.latitude !== undefined ? overrides.latitude : 51.4775,
    overrides?.baroAltitude !== undefined ? overrides.baroAltitude : 10000,
    overrides?.onGround !== undefined ? overrides.onGround : false,
    overrides?.velocity !== undefined ? overrides.velocity : 250,
    overrides?.trueTrack !== undefined ? overrides.trueTrack : 90,
  ];
}

describe("OpenSkyIntegrationPlugin", () => {
  let plugin: OpenSkyIntegrationPlugin;

  beforeEach(() => {
    plugin = new OpenSkyIntegrationPlugin();
    plugin.configure({});
    vi.clearAllMocks();
  });

  it("should return flight records on 200", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ time: 1705316400, states: [makeState()] }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_FLIGHT_POSITION);
    expect(records[0]?.source).toBe(OPENSKY_INTEGRATION_ID);
    expect(records[0]?.entityKey).toBe("icao24:a1b2c3");
  });

  it("should skip records with null latitude", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [
          makeState({ icao24: "aaa111", latitude: null }),
          makeState({ icao24: "bbb222" }),
        ],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.entityKey).toBe("icao24:bbb222");
  });

  it("should skip records with null longitude", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [
          makeState({ icao24: "aaa111", longitude: null }),
          makeState({ icao24: "bbb222" }),
        ],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.entityKey).toBe("icao24:bbb222");
  });

  it("should convert velocity m/s to knots correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ velocity: 100 })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBeCloseTo(194.384, 2);
  });

  it("should set speedKt to null when velocity is null", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ velocity: null })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.speedKt).toBeNull();
  });

  it("should apply Basic auth header when both secrets are present", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    await plugin.execute(
      "fetch-flights",
      makeContext({ username: "user", password: "pass" }) as never,
    );

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe(`Basic ${btoa("user:pass")}`);
  });

  it("should not send auth header when secrets are absent", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    await plugin.execute("fetch-flights", makeContext() as never);

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("should not send auth header when only username is present", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    await plugin.execute(
      "fetch-flights",
      makeContext({ username: "user" }) as never,
    );

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("should send bounding box query params when configured", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    plugin.configure({
      boundingBox: { minLat: 45, maxLat: 55, minLon: -5, maxLon: 10 },
    });

    await plugin.execute("fetch-flights", makeContext() as never);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("lamin=45");
    expect(url).toContain("lamax=55");
    expect(url).toContain("lomin=-5");
    expect(url).toContain("lomax=10");
  });

  it("should not send bounding box params when not configured", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    await plugin.execute("fetch-flights", makeContext() as never);

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://opensky-network.org/api/states/all");
  });

  it("should pass abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-flights",
      makeContext({ signal: controller.signal }) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass null signal when context has no signal", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ time: 1705316400, states: [] }));

    await plugin.execute("fetch-flights", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should throw RateLimitError on 429 with retryAfterMs 60000", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toMatchObject({
      constructor: RateLimitError,
      retryAfterMs: 60_000,
    });
  });

  it("should throw TransientError on 500 with message containing HTTP status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-flights", makeContext() as never),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof TransientError && /HTTP 500/.test(e.message),
    );
  });

  it("should throw on unknown operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should handle null states array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ time: 1705316400, states: null }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should set lastContact as ISO string from unix seconds", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ lastContact: 1705316400 })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.lastContact).toBe("2024-01-15T11:00:00.000Z");
  });

  it("should set onGround correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ onGround: true })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.onGround).toBe(true);
  });

  it("should trim callsign trailing spaces", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ callsign: "BAW123  " })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBe("BAW123");
  });

  it("should set callsign to null when it is null", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ callsign: null })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should set callsign to null when it is all whitespace", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [makeState({ callsign: "   " })],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]?.data.callsign).toBeNull();
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-opensky",
      name: "OpenSky Network",
      version: "0.1.0-beta.1",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-flights",
          name: "Fetch Flights",
          recordType: "flight.position",
        },
      ],
      auth: {
        type: "basic",
        secrets: [
          { key: "OPENSKY_USERNAME", required: false },
          { key: "OPENSKY_PASSWORD", required: false },
        ],
      },
      polling: { defaultIntervalMs: 30_000, minIntervalMs: 10_000 },
      rateLimit: { requestsPerMinute: 4, maxConcurrentRequests: 1 },
    });
  });

  it("should accept an empty config object (no bounding box)", () => {
    expect(() => openSkyConfigSchema.parse({})).not.toThrow();
  });

  it("should accept a valid bounding box config", () => {
    expect(() =>
      openSkyConfigSchema.parse({
        boundingBox: { minLat: 45, maxLat: 55, minLon: -5, maxLon: 10 },
      }),
    ).not.toThrow();
  });

  it("should reject latitude out of range in bounding box", () => {
    expect(() =>
      openSkyConfigSchema.parse({
        boundingBox: { minLat: -91, maxLat: 55, minLon: -5, maxLon: 10 },
      }),
    ).toThrow();
  });

  it("should reject longitude out of range in bounding box", () => {
    expect(() =>
      openSkyConfigSchema.parse({
        boundingBox: { minLat: 45, maxLat: 55, minLon: -181, maxLon: 10 },
      }),
    ).toThrow();
  });

  it("should map all fields of a state into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        time: 1705316400,
        states: [
          makeState({
            icao24: "abc123",
            callsign: "DLH400 ",
            lastContact: 1705316400,
            longitude: 13.4,
            latitude: 52.5,
            baroAltitude: 8000,
            onGround: false,
            velocity: 200,
            trueTrack: 270,
          }),
        ],
      }),
    );

    const records = await plugin.execute(
      "fetch-flights",
      makeContext() as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_FLIGHT_POSITION,
      source: OPENSKY_INTEGRATION_ID,
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "icao24:abc123",
      data: {
        icao24: "abc123",
        callsign: "DLH400",
        latitude: 52.5,
        longitude: 13.4,
        altitudeM: 8000,
        speedKt: expect.closeTo(200 * 1.94384, 3),
        heading: 270,
        onGround: false,
        lastContact: "2024-01-15T11:00:00.000Z",
      },
    });
  });
});
