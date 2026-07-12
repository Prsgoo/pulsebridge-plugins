import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const CRYPTO_TICKER_PROCESSOR_ID = "@prsgoo/processor-crypto-ticker";
export const RECORD_TYPE_CRYPTO_PRICE = "crypto.price";
export const VIEW_CRYPTO_TICKER = "crypto-ticker";

export interface CryptoTickerItem {
  coinId: string;
  name: string;
  symbol: string;
  priceUsd: number;
  /** % change in the last 24h as reported by CoinGecko. */
  change24hPercent: number;
  /** Price difference vs the previous poll. Zero on first poll. */
  priceDelta: number;
  direction: "up" | "down" | "flat";
  updatedAt: string;
}

interface CryptoPriceData {
  coinId: string;
  priceUsd: number;
  change24hPercent: number;
}

interface CoinLabel {
  name: string;
  symbol: string;
}

const COIN_LABELS: Record<string, CoinLabel> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC" },
  ethereum: { name: "Ethereum", symbol: "ETH" },
  solana: { name: "Solana", symbol: "SOL" },
  binancecoin: { name: "BNB", symbol: "BNB" },
  ripple: { name: "XRP", symbol: "XRP" },
  cardano: { name: "Cardano", symbol: "ADA" },
  dogecoin: { name: "Dogecoin", symbol: "DOGE" },
  polkadot: { name: "Polkadot", symbol: "DOT" },
  avalanche: { name: "Avalanche", symbol: "AVAX" },
  chainlink: { name: "Chainlink", symbol: "LINK" },
};

const STATE_KEY = `${CRYPTO_TICKER_PROCESSOR_ID}:prices`;

export class CryptoTickerProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: CRYPTO_TICKER_PROCESSOR_ID,
    name: "Crypto Ticker Processor",
    version: "0.1.0",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_CRYPTO_PRICE],
    produces: [VIEW_CRYPTO_TICKER],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<CryptoTickerItem> | null> {
    const priceRecords = records.filter(
      (r) => r.type === RECORD_TYPE_CRYPTO_PRICE,
    ) as ReadonlyArray<PulseRecord<CryptoPriceData>>;
    if (priceRecords.length === 0) return null;

    const latestByCoin = new Map<string, PulseRecord<CryptoPriceData>>();
    for (const record of priceRecords) {
      const existing = latestByCoin.get(record.data.coinId);
      if (!existing || record.timestamp > existing.timestamp) {
        latestByCoin.set(record.data.coinId, record);
      }
    }

    const storedPrices = await context.stateStore?.get(STATE_KEY);
    const previousPrices: Record<string, number> = storedPrices
      ? (JSON.parse(storedPrices) as Record<string, number>)
      : {};

    const items: CryptoTickerItem[] = Array.from(latestByCoin.values()).map(
      (record) => {
        const { coinId, priceUsd, change24hPercent } = record.data;
        const prev = previousPrices[coinId];
        const priceDelta = prev !== undefined ? priceUsd - prev : 0;
        const direction =
          priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "flat";
        const label = COIN_LABELS[coinId] ?? {
          name: coinId.charAt(0).toUpperCase() + coinId.slice(1),
          symbol: coinId.toUpperCase().slice(0, 4),
        };

        return {
          coinId,
          name: label.name,
          symbol: label.symbol,
          priceUsd,
          change24hPercent,
          priceDelta,
          direction,
          updatedAt: record.timestamp,
        };
      },
    );

    const newPrices: Record<string, number> = {};
    for (const item of items) {
      newPrices[item.coinId] = item.priceUsd;
    }
    await context.stateStore?.set(STATE_KEY, JSON.stringify(newPrices));

    context.logger.debug("Crypto ticker updated.", { coins: items.length });

    return {
      view: VIEW_CRYPTO_TICKER,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
