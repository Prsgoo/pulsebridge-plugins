import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginAuthError,
  PluginKinds,
  RateLimitError,
  TransientError,
} from "pulsebridge";
import {
  FinnhubMarketsIntegrationPlugin,
  RECORD_TYPE_MARKET_QUOTE,
  finnhubConfigSchema,
} from "../finnhubMarketsIntegrationPlugin.js";

const TEST_KEY = "demo-value";
const withKey = { FINNHUB_API_KEY: TEST_KEY };

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

const validQuote = {
  c: 182.5,
  d: 1.5,
  dp: 0.83,
  h: 184.0,
  l: 180.0,
  o: 181.0,
  pc: 181.0,
  t: 1705316400,
};

describe("FinnhubMarketsIntegrationPlugin", () => {
  let plugin: FinnhubMarketsIntegrationPlugin;

  beforeEach(() => {
    plugin = new FinnhubMarketsIntegrationPlugin();
    plugin.configure({ symbols: ["AAPL"] });
    vi.clearAllMocks();
  });

  it("should return market quote records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(validQuote));

    const records = await plugin.execute(
      "fetch-quotes",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe(RECORD_TYPE_MARKET_QUOTE);
    expect(records[0]?.entityKey).toBe("finnhub:AAPL");
    expect(records[0]?.data.symbol).toBe("AAPL");
    expect(records[0]?.data.currentPrice).toBe(182.5);
  });

  it("should skip symbols where c === 0 (no data available)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ ...validQuote, c: 0 }),
    );

    const records = await plugin.execute(
      "fetch-quotes",
      makeContext(withKey) as never,
    );

    expect(records).toHaveLength(0);
  });

  it("should throw PluginAuthError when FINNHUB_API_KEY is missing", async () => {
    await expect(
      plugin.execute("fetch-quotes", makeContext() as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw PluginAuthError on 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw PluginAuthError on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(403));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext(withKey) as never),
    ).rejects.toThrow("not supported");
  });

  it("should map every quote field into the record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(validQuote));

    const records = await plugin.execute(
      "fetch-quotes",
      makeContext(withKey) as never,
    );

    expect(records[0]).toMatchObject({
      type: RECORD_TYPE_MARKET_QUOTE,
      source: "@prsgoo/integration-finnhub-markets",
      timestamp: "2024-01-15T12:00:00.000Z",
      entityKey: "finnhub:AAPL",
      data: {
        symbol: "AAPL",
        currentPrice: 182.5,
        change: 1.5,
        changePercent: 0.83,
        high: 184.0,
        low: 180.0,
        open: 181.0,
        previousClose: 181.0,
        tradeTimestamp: "2024-01-15T11:00:00.000Z",
      },
    });
  });

  it("should request the quote endpoint with the symbol and token header", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(validQuote));

    await plugin.execute("fetch-quotes", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://finnhub.io/api/v1/quote?symbol=AAPL",
    );
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers["X-Finnhub-Token"]).toBe(TEST_KEY);
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(validQuote));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-quotes",
      makeContext(withKey, controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse(validQuote));

    await plugin.execute("fetch-quotes", makeContext(withKey) as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should describe the missing secret in the auth error", async () => {
    await expect(
      plugin.execute("fetch-quotes", makeContext() as never),
    ).rejects.toThrow(/FINNHUB_API_KEY/);
  });

  it("should describe an invalid key in the auth error on 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toThrow(/invalid/i);
  });

  it("should report a 60s retry delay on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should include the status code in the transient error message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(503));

    await expect(
      plugin.execute("fetch-quotes", makeContext(withKey) as never),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-finnhub-markets",
      name: "Finnhub Markets",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-quotes",
          name: "Fetch Quotes",
          recordType: "market.quote",
        },
      ],
      auth: {
        type: "apiKey",
        secrets: [{ key: "FINNHUB_API_KEY", required: true }],
      },
      polling: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 30_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 60, maxConcurrentRequests: 1 },
    });
  });

  it("should default to a built-in symbol list", () => {
    expect(finnhubConfigSchema.parse({}).symbols).toEqual([
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "META",
      "TSLA",
      "SPY",
      "QQQ",
    ]);
  });

  it("should reject an empty symbol list", () => {
    expect(() => finnhubConfigSchema.parse({ symbols: [] })).toThrow();
  });

  it("should reject more than 50 symbols", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `S${i}`);
    expect(() => finnhubConfigSchema.parse({ symbols: tooMany })).toThrow();
  });

  it("should reject empty symbol strings", () => {
    expect(() => finnhubConfigSchema.parse({ symbols: [""] })).toThrow();
  });
});
