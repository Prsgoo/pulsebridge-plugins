import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  FredEconomicsIntegrationPlugin,
  RECORD_TYPE_ECONOMIC_INDICATOR,
  fredConfigSchema,
} from "../fredEconomicsIntegrationPlugin.js";

const TEST_KEY = "demo-value";
const withKey = { FRED_API_KEY: TEST_KEY };

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

const fredObsResponse = {
  observations: [
    {
      realtime_start: "2024-01-01",
      realtime_end: "2024-01-15",
      date: "2024-01-01",
      value: "5.33",
    },
  ],
};

describe("FredEconomicsIntegrationPlugin", () => {
  let plugin: FredEconomicsIntegrationPlugin;

  beforeEach(() => {
    plugin = new FredEconomicsIntegrationPlugin();
    plugin.configure({ series: ["FEDFUNDS"] });
    vi.clearAllMocks();
  });

  it("should return economic indicator records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(fredObsResponse),
    );

    const records = await plugin.execute(
      "fetch-indicators",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_ECONOMIC_INDICATOR);
    expect(records[0]?.entityKey).toBe("fred:FEDFUNDS:2024-01-01");
    expect(records[0]?.data.value).toBe(5.33);
    expect(records[0]?.data.seriesId).toBe("FEDFUNDS");
  });

  it("should map every observation field into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(fredObsResponse),
    );

    const records = await plugin.execute(
      "fetch-indicators",
      makeContext(withKey) as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_ECONOMIC_INDICATOR,
      source: "@prsgoo/integration-fred-economics",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "fred:FEDFUNDS:2024-01-01",
      data: {
        seriesId: "FEDFUNDS",
        value: 5.33,
        date: "2024-01-01",
        realtimeStart: "2024-01-01",
        realtimeEnd: "2024-01-15",
      },
    });
  });

  it("should request the series observations endpoint with key and query", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(fredObsResponse));

    await plugin.execute("fetch-indicators", makeContext(withKey) as never);

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.stlouisfed.org/fred/series/observations",
    );
    expect(url.searchParams.get("series_id")).toBe("FEDFUNDS");
    expect(url.searchParams.get("api_key")).toBe(TEST_KEY);
    expect(url.searchParams.get("file_type")).toBe("json");
    expect(url.searchParams.get("sort_order")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(fredObsResponse));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-indicators",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(fredObsResponse));

    await plugin.execute("fetch-indicators", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should skip series with missing value ('.')", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        observations: [
          {
            realtime_start: "2024-01-01",
            realtime_end: "2024-01-15",
            date: "2024-01-01",
            value: ".",
          },
        ],
      }),
    );

    const records = await plugin.execute(
      "fetch-indicators",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should skip series with no observations", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ observations: [] }),
    );

    const records = await plugin.execute(
      "fetch-indicators",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should throw PluginAuthError when FRED_API_KEY is missing", async () => {
    await expect(
      plugin.execute("fetch-indicators", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should name the missing secret in the auth error", async () => {
    await expect(
      plugin.execute("fetch-indicators", makeContext() as never),
    ).rejects.toThrow(/FRED_API_KEY/);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should describe an invalid key on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toThrow(/invalid/i);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should report a 60s retry delay on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should mention the rate limit in the 429 error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toThrow(/rate limit/i);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-indicators", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-fred-economics",
      name: "FRED Economics",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-indicators",
          name: "Fetch Indicators",
          recordType: "economic.indicator",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [{ key: "FRED_API_KEY", required: true }],
      },
      polling: {
        defaultIntervalMs: 3_600_000,
        minIntervalMs: 900_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 60, maxConcurrentRequests: 1 },
    });
  });

  it("should default to the built-in series list", () => {
    expect(fredConfigSchema.parse({}).series).toEqual([
      "FEDFUNDS",
      "CPIAUCSL",
      "UNRATE",
      "GDP",
      "DGS10",
    ]);
  });

  it("should reject an empty series list", () => {
    expect(() => fredConfigSchema.parse({ series: [] })).toThrow();
  });

  it("should reject empty series id strings", () => {
    expect(() => fredConfigSchema.parse({ series: [""] })).toThrow();
  });
});
