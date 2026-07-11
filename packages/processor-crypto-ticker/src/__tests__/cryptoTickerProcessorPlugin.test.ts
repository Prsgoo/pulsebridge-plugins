import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  CryptoTickerProcessorPlugin,
  VIEW_CRYPTO_TICKER,
} from "../cryptoTickerProcessorPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeStateStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeContext(stateStore = makeStateStore()): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-01-15T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
    stateStore,
  } as unknown as RuntimeContext;
}

function makePriceRecord(coinId: string, price: number): PulseRecord {
  return {
    type: "crypto.price",
    timestamp: "2024-01-15T11:00:00Z",
    source: "@pulsebridge/integration-coingecko",
    entityKey: `coin:${coinId}`,
    data: { coinId, priceUsd: price, change24hPercent: 1.5 },
  };
}

describe("CryptoTickerProcessorPlugin", () => {
  let plugin: CryptoTickerProcessorPlugin;

  beforeEach(() => {
    plugin = new CryptoTickerProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a crypto-ticker view from price records", async () => {
    const records = [makePriceRecord("bitcoin", 42000)];
    const view = await plugin.process(records, makeContext());
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_CRYPTO_TICKER);
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.coinId).toBe("bitcoin");
    expect(view?.items[0]?.priceUsd).toBe(42000);
    expect(view?.items[0]?.name).toBe("Bitcoin");
    expect(view?.items[0]?.symbol).toBe("BTC");
  });

  it("should calculate priceDelta as zero on first poll", async () => {
    const view = await plugin.process(
      [makePriceRecord("bitcoin", 42000)],
      makeContext(),
    );
    expect(view?.items[0]?.priceDelta).toBe(0);
    expect(view?.items[0]?.direction).toBe("flat");
  });

  it("should calculate positive priceDelta when price went up", async () => {
    const prevPrices = { bitcoin: 40000 };
    const stateStore = makeStateStore({
      "@prsgoo/processor-crypto-ticker:prices": JSON.stringify(prevPrices),
    });
    const view = await plugin.process(
      [makePriceRecord("bitcoin", 42000)],
      makeContext(stateStore),
    );
    expect(view?.items[0]?.priceDelta).toBe(2000);
    expect(view?.items[0]?.direction).toBe("up");
  });

  it("should calculate negative priceDelta when price went down", async () => {
    const prevPrices = { ethereum: 3000 };
    const stateStore = makeStateStore({
      "@prsgoo/processor-crypto-ticker:prices": JSON.stringify(prevPrices),
    });
    const view = await plugin.process(
      [makePriceRecord("ethereum", 2500)],
      makeContext(stateStore),
    );
    expect(view?.items[0]?.priceDelta).toBe(-500);
    expect(view?.items[0]?.direction).toBe("down");
  });

  it("should use fallback label for unknown coin IDs", async () => {
    const view = await plugin.process(
      [makePriceRecord("unknowncoin", 1.0)],
      makeContext(),
    );
    expect(view?.items[0]?.name).toBe("Unknowncoin");
    expect(view?.items[0]?.symbol).toBe("UNKN");
  });

  it("should keep only latest record per coin when duplicates exist", async () => {
    const older = {
      ...makePriceRecord("bitcoin", 40000),
      timestamp: "2024-01-15T10:00:00Z",
    };
    const newer = {
      ...makePriceRecord("bitcoin", 42000),
      timestamp: "2024-01-15T11:00:00Z",
    };
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.priceUsd).toBe(42000);
  });

  it("should return null when no price records are present", async () => {
    const unrelated: PulseRecord = {
      type: "weather.current",
      timestamp: "2024-01-15T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });
});
