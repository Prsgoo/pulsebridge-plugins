import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  NasaDonkiIntegrationPlugin,
  RECORD_TYPE_SOLAR_FLARE,
  donkiConfigSchema,
} from "../nasaDonkiIntegrationPlugin.js";

const TEST_KEY = "demo-value";
const withKey = { NASA_API_KEY: TEST_KEY };

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

function makeOkResponse(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: (h: string) => headers[h] ?? null },
  } as unknown as Response;
}

function makeErrorResponse(
  status: number,
  headers: Record<string, string> = {},
) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: { get: (h: string) => headers[h] ?? null },
  } as unknown as Response;
}

const rawFlare = {
  flrID: "2024-01-15T10:00:00-FLR-001",
  classType: "X1.5",
  beginTime: "2024-01-15T10:00:00Z",
  peakTime: "2024-01-15T10:05:00Z",
  endTime: "2024-01-15T10:10:00Z",
  sourceLocation: "N20W15",
  activeRegionNum: 3227,
  note: "Significant flare",
  linkedEvents: [{ activityID: "CME-001" }],
  link: "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/FLR/1",
};

describe("NasaDonkiIntegrationPlugin", () => {
  let plugin: NasaDonkiIntegrationPlugin;

  beforeEach(() => {
    plugin = new NasaDonkiIntegrationPlugin();
    plugin.configure({ lookbackDays: 7 });
    vi.clearAllMocks();
  });

  it("should return solar flare records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([rawFlare]));

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_SOLAR_FLARE);
    expect(records[0]?.entityKey).toBe("flare:2024-01-15T10:00:00-FLR-001");
    expect(records[0]?.data.severity).toBe("major");
    expect(records[0]?.data.classType).toBe("X1.5");
    expect(records[0]?.data.linkedEventIds).toEqual(["CME-001"]);
  });

  it("should map every flare field into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([rawFlare]));

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_SOLAR_FLARE,
      source: "@prsgoo/integration-nasa-donki",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "flare:2024-01-15T10:00:00-FLR-001",
      data: {
        flrId: "2024-01-15T10:00:00-FLR-001",
        classType: "X1.5",
        severity: "major",
        beginTime: "2024-01-15T10:00:00Z",
        peakTime: "2024-01-15T10:05:00Z",
        endTime: "2024-01-15T10:10:00Z",
        sourceLocation: "N20W15",
        activeRegionNum: 3227,
        note: "Significant flare",
        linkedEventIds: ["CME-001"],
        link: "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/FLR/1",
      },
    });
  });

  it("should request the DONKI endpoint with the date window and key", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([]));

    await plugin.execute("fetch-solar-flares", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://api.nasa.gov/DONKI/FLR");
    expect(url.searchParams.get("startDate")).toBe("2024-01-08");
    expect(url.searchParams.get("endDate")).toBe("2024-01-15");
    expect(url.searchParams.get("api_key")).toBe(TEST_KEY);
  });

  it("should derive the start date from a reconfigured lookback window", async () => {
    plugin.configure({ lookbackDays: 1 });
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([]));

    await plugin.execute("fetch-solar-flares", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get("startDate")).toBe("2024-01-14");
  });

  it("should log the date window being fetched", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([]));

    await plugin.execute("fetch-solar-flares", makeContext(withKey) as never);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      "Fetching DONKI solar flares.",
      { startDate: "2024-01-08", endDate: "2024-01-15" },
    );
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([]));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse([]));

    await plugin.execute("fetch-solar-flares", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should return empty array when API returns empty array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse([]));

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should return empty array when response is not an array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse({}));

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should warn when the response is not an array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse({}));

    await plugin.execute("fetch-solar-flares", makeContext(withKey) as never);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Unexpected DONKI response shape — expected array.",
    );
  });

  it("should throw PluginAuthError when NASA_API_KEY is missing", async () => {
    await expect(
      plugin.execute("fetch-solar-flares", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should name the missing secret in the auth error", async () => {
    await expect(
      plugin.execute("fetch-solar-flares", makeContext() as never),
    ).rejects.toThrow(/NASA_API_KEY/);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should describe an invalid key on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toThrow(/invalid/i);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should derive the rate-limit backoff from the X-Retry-After header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "X-Retry-After": "30" }),
    );

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("should default the backoff to 60s when no retry header is present", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should mention the rate limit in the 429 error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toThrow(/rate limit/i);
  });

  it("should default optional flare fields when the upstream omits them", async () => {
    const minimalFlare = {
      flrID: "2024-01-15T10:00:00-FLR-002",
      classType: "M2.0",
      beginTime: "2024-01-15T10:00:00Z",
      link: "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/FLR/2",
    };
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse([minimalFlare]),
    );

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records[0]?.data).toMatchObject({
      peakTime: null,
      endTime: null,
      sourceLocation: null,
      activeRegionNum: null,
      note: "",
      linkedEventIds: [],
    });
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-solar-flares", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should correctly classify flare severity", async () => {
    const flares = [
      { ...rawFlare, flrID: "flr-1", classType: "X1.0" },
      { ...rawFlare, flrID: "flr-2", classType: "M5.0" },
      { ...rawFlare, flrID: "flr-3", classType: "C2.0" },
      { ...rawFlare, flrID: "flr-4", classType: "B1.0" },
    ];
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(flares));

    const records = await plugin.execute(
      "fetch-solar-flares",
      makeContext(withKey) as never,
    );

    expect(records[0]?.data.severity).toBe("major");
    expect(records[1]?.data.severity).toBe("significant");
    expect(records[2]?.data.severity).toBe("moderate");
    expect(records[3]?.data.severity).toBe("minor");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-nasa-donki",
      name: "NASA DONKI Solar Flares",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-solar-flares",
          name: "Fetch Solar Flares",
          recordType: "space.solar-flare",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [
          {
            key: "NASA_API_KEY",
            description:
              "NASA Open APIs key — get one free at api.nasa.gov. Use DEMO_KEY for testing.",
            required: true,
          },
        ],
      },
      polling: {
        defaultIntervalMs: 3_600_000,
        minIntervalMs: 900_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 10, maxConcurrentRequests: 1 },
    });
  });

  it("should default the lookback window to 7 days", () => {
    expect(donkiConfigSchema.parse({}).lookbackDays).toBe(7);
  });

  it("should reject a lookback window below 1 day", () => {
    expect(() => donkiConfigSchema.parse({ lookbackDays: 0 })).toThrow();
  });

  it("should reject a lookback window above 30 days", () => {
    expect(() => donkiConfigSchema.parse({ lookbackDays: 31 })).toThrow();
  });
});
