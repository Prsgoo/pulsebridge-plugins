import { z } from "zod";
import {
  PluginKinds,
  PluginAuthError,
  RateLimitError,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const FINNHUB_INTEGRATION_ID = "@prsgoo/integration-finnhub-markets";
export const RECORD_TYPE_MARKET_QUOTE = "market.quote";

const FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote";

export const finnhubConfigSchema = z.object({
  symbols: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .default(["AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "SPY", "QQQ"]),
});

export type FinnhubConfig = z.infer<typeof finnhubConfigSchema>;

export interface MarketQuoteData {
  symbol: string;
  currentPrice: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  /** ISO timestamp converted from Finnhub's Unix `t` field. */
  tradeTimestamp: string;
}

interface FinnhubQuoteResponse {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

export class FinnhubMarketsIntegrationPlugin implements IntegrationPlugin<FinnhubConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: FINNHUB_INTEGRATION_ID,
    name: "Finnhub Markets",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      {
        id: "fetch-quotes",
        name: "Fetch Quotes",
        recordType: RECORD_TYPE_MARKET_QUOTE,
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
    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 1,
    },
  };

  readonly configSchema = finnhubConfigSchema;

  private config: FinnhubConfig = finnhubConfigSchema.parse({});

  configure(config: FinnhubConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<MarketQuoteData>>> {
    if (operationId !== "fetch-quotes") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const apiKey = context.secrets.get("FINNHUB_API_KEY");
    if (!apiKey) {
      throw new PluginAuthError(
        "FINNHUB_API_KEY secret is required but not set.",
      );
    }

    const records: PulseRecord<MarketQuoteData>[] = [];
    const now = context.now().toISOString();

    for (const symbol of this.config.symbols) {
      const response = await fetch(`${FINNHUB_QUOTE_URL}?symbol=${symbol}`, {
        headers: { "X-Finnhub-Token": apiKey },
        signal: context.signal ?? null,
      });

      if (response.status === 401 || response.status === 403) {
        throw new PluginAuthError("Finnhub API key is invalid.");
      }
      if (response.status === 429) {
        throw new RateLimitError("Finnhub rate limit reached.", 60_000);
      }
      if (!response.ok) {
        throw new TransientError(
          `Finnhub API returned HTTP ${response.status}.`,
        );
      }

      const quote = (await response.json()) as FinnhubQuoteResponse;

      if (quote.c === 0) continue;

      records.push({
        type: RECORD_TYPE_MARKET_QUOTE,
        timestamp: now,
        source: FINNHUB_INTEGRATION_ID,
        entityKey: `finnhub:${symbol}`,
        data: {
          symbol,
          currentPrice: quote.c,
          change: quote.d,
          changePercent: quote.dp,
          high: quote.h,
          low: quote.l,
          open: quote.o,
          previousClose: quote.pc,
          tradeTimestamp: new Date(quote.t * 1000).toISOString(),
        },
      });
    }

    return records;
  }
}
