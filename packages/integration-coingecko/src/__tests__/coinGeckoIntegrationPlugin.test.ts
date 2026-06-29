import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds, RateLimitError, TransientError } from "pulsebridge";
import {
  CoinGeckoIntegrationPlugin,
  COINGECKO_INTEGRATION_ID,
  RECORD_TYPE_CRYPTO_PRICE,
  coinGeckoConfigSchema,
} from "../coinGeckoIntegrationPlugin.js";

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

describe("CoinGeckoIntegrationPlugin", () => {
  let plugin: CoinGeckoIntegrationPlugin;

  beforeEach(() => {
    plugin = new CoinGeckoIntegrationPlugin();
    plugin.configure({ coins: ["bitcoin", "ethereum"] });
    vi.clearAllMocks();
  });

  it("should return price records on successful response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        bitcoin: { usd: 42000, usd_24h_change: 2.5 },
        ethereum: { usd: 2500, usd_24h_change: -1.2 },
      }),
    );

    const ctx = makeContext();
    const records = await plugin.execute("fetch-prices", ctx as never);

    expect(records).toHaveLength(2);
    expect(records[0]?.type).toBe(RECORD_TYPE_CRYPTO_PRICE);
    expect(records[0]?.entityKey).toBe("coin:bitcoin");
    expect(records[0]?.data.priceUsd).toBe(42000);
    expect(records[0]?.data.change24hPercent).toBe(2.5);
  });

  it("should set the second record fields from its own entry", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        bitcoin: { usd: 42000, usd_24h_change: 2.5 },
        ethereum: { usd: 2500, usd_24h_change: -1.2 },
      }),
    );

    const records = await plugin.execute(
      "fetch-prices",
      makeContext() as never,
    );

    expect(records[1]?.entityKey).toBe("coin:ethereum");
    expect(records[1]?.data.coinId).toBe("ethereum");
    expect(records[1]?.data.priceUsd).toBe(2500);
    expect(records[1]?.data.change24hPercent).toBe(-1.2);
  });

  it("should stamp records with source and current time", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ bitcoin: { usd: 42000, usd_24h_change: 2.5 } }),
    );

    const records = await plugin.execute(
      "fetch-prices",
      makeContext() as never,
    );

    expect(records[0]?.source).toBe(COINGECKO_INTEGRATION_ID);
    expect(records[0]?.timestamp).toBe("2024-01-15T12:00:00.000Z");
  });

  it("should request the configured coins with usd price and 24h change", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({}));

    await plugin.execute("fetch-prices", makeContext() as never);

    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      "https://api.coingecko.com/api/v3/simple/price",
    );
    expect(calledUrl.searchParams.get("ids")).toBe("bitcoin,ethereum");
    expect(calledUrl.searchParams.get("vs_currencies")).toBe("usd");
    expect(calledUrl.searchParams.get("include_24hr_change")).toBe("true");
  });

  it("should forward the abort signal to fetch", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({}));
    const controller = new AbortController();

    await plugin.execute(
      "fetch-prices",
      makeContext(controller.signal) as never,
    );

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("should pass a null signal to fetch when context has none", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeOkResponse({}));

    await plugin.execute("fetch-prices", makeContext() as never);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeNull();
  });

  it("should skip coins not present in response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({
        bitcoin: { usd: 42000, usd_24h_change: 2.5 },
      }),
    );

    const records = await plugin.execute(
      "fetch-prices",
      makeContext() as never,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.data.coinId).toBe("bitcoin");
  });

  it("should warn when a coin is missing from the response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse({ bitcoin: { usd: 42000, usd_24h_change: 2.5 } }),
    );

    await plugin.execute("fetch-prices", makeContext() as never);

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.any(String), {
      coinId: "ethereum",
    });
  });

  it("should throw RateLimitError on 429", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("should default to 60s retry delay when 429 has no retry header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("should derive retry delay from the Retry-After header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "Retry-After": "30" }),
    );

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("should fall back to X-RateLimit-Reset when Retry-After is absent", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeErrorResponse(429, { "X-RateLimit-Reset": "5" }),
    );

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toMatchObject({ retryAfterMs: 5_000 });
  });

  it("should throw TransientError on 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("should throw on unsupported operationId", async () => {
    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toEqual({
      id: "@prsgoo/integration-coingecko",
      name: "CoinGecko Crypto Prices",
      version: "0.1.0",
      kind: PluginKinds.INTEGRATION,
      operations: [
        {
          id: "fetch-prices",
          name: "Fetch Prices",
          recordType: "crypto.price",
        },
      ],
      auth: { type: "none" },
      polling: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 30_000,
        hard: false,
      },
      rateLimit: { requestsPerMinute: 10, maxConcurrentRequests: 1 },
    });
  });

  it("should default to the built-in coin list", () => {
    const parsed = coinGeckoConfigSchema.parse({});
    expect(parsed.coins).toEqual([
      "bitcoin",
      "ethereum",
      "solana",
      "binancecoin",
    ]);
  });

  it("should accept a valid coin list", () => {
    expect(
      coinGeckoConfigSchema.parse({ coins: ["bitcoin", "ethereum"] }).coins,
    ).toEqual(["bitcoin", "ethereum"]);
  });

  it("should reject an empty coin list", () => {
    expect(() => coinGeckoConfigSchema.parse({ coins: [] })).toThrow();
  });

  it("should reject more than 20 coins", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `coin${i}`);
    expect(() => coinGeckoConfigSchema.parse({ coins: tooMany })).toThrow();
  });

  it("should reject empty coin id strings", () => {
    expect(() => coinGeckoConfigSchema.parse({ coins: [""] })).toThrow();
  });

  it("should log which coins it is fetching", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse({}));

    await plugin.execute("fetch-prices", makeContext() as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("Fetching crypto prices.", {
      coins: ["bitcoin", "ethereum"],
    });
  });

  it("should describe the rate limit in the thrown error", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeErrorResponse(429));

    await expect(
      plugin.execute("fetch-prices", makeContext() as never),
    ).rejects.toThrow(/rate limit/i);
  });
});
