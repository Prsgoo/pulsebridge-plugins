import {
  PluginKinds,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";
import { z } from "zod";

export const COINGECKO_INTEGRATION_ID = "@prsgoo/integration-coingecko";
export const RECORD_TYPE_CRYPTO_PRICE = "crypto.price";

const BASE_URL = "https://api.coingecko.com/api/v3/simple/price";

const DEFAULT_COINS = ["bitcoin", "ethereum", "solana", "binancecoin"];

export const coinGeckoConfigSchema = z.object({
  /**
   * CoinGecko coin IDs to track, e.g. "bitcoin", "ethereum", "solana".
   * Full list at api.coingecko.com/api/v3/coins/list
   */
  coins: z.array(z.string().min(1)).min(1).max(20).default(DEFAULT_COINS),
});

export type CoinGeckoConfig = z.infer<typeof coinGeckoConfigSchema>;

export interface CryptoPriceData {
  /** CoinGecko coin ID, e.g. "bitcoin". */
  coinId: string;
  priceUsd: number;
  /** Percentage price change over the last 24 hours. */
  change24hPercent: number;
}

type CoinGeckoResponse = Record<
  string,
  { usd: number; usd_24h_change: number }
>;

export class CoinGeckoIntegrationPlugin implements IntegrationPlugin<CoinGeckoConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: COINGECKO_INTEGRATION_ID,
    name: "CoinGecko Crypto Prices",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-prices",
        name: "Fetch Prices",
        recordType: RECORD_TYPE_CRYPTO_PRICE,
      },
    ],
    auth: { type: "none" },
    polling: {
      defaultIntervalMs: 60_000,
      minIntervalMs: 30_000,
      hard: false,
    },
    rateLimit: {
      requestsPerMinute: 10,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = coinGeckoConfigSchema;

  private config: CoinGeckoConfig = { coins: DEFAULT_COINS };

  configure(config: CoinGeckoConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<CryptoPriceData>>> {
    if (operationId !== "fetch-prices") {
      throw new Error(
        `Operation '${operationId}' is not supported by '${this.manifest.id}'.`,
      );
    }

    const url = new URL(BASE_URL);
    url.searchParams.set("ids", this.config.coins.join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_24hr_change", "true");

    context.logger.debug("Fetching crypto prices.", {
      coins: this.config.coins,
    });

    const response = await fetch(url.toString(), {
      signal: context.signal ?? null,
    });

    if (response.status === 429) {
      const retryAfter =
        response.headers.get("Retry-After") ??
        response.headers.get("X-RateLimit-Reset");
      throw new RateLimitError(
        "CoinGecko rate limit reached.",
        retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : 60_000,
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `CoinGecko API returned HTTP ${response.status}.`,
      );
    }

    const data = (await response.json()) as CoinGeckoResponse;
    const now = context.now().toISOString();

    return this.config.coins.flatMap((coinId) => {
      const entry = data[coinId];
      if (!entry) {
        context.logger.warn("No data returned for coin — skipping.", {
          coinId,
        });
        return [];
      }
      return [
        {
          type: RECORD_TYPE_CRYPTO_PRICE,
          timestamp: now,
          source: COINGECKO_INTEGRATION_ID,
          entityKey: `coin:${coinId}`,
          data: {
            coinId,
            priceUsd: entry.usd,
            change24hPercent: entry.usd_24h_change,
          },
        },
      ];
    });
  }
}
