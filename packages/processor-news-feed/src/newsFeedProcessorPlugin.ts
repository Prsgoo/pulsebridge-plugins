import {
  PluginKinds,
  type ProcessorPlugin,
  type ProcessorPluginManifest,
  type PulseRecord,
  type PulseViewRecord,
  type RuntimeContext,
} from "pulsebridge";

export const NEWS_FEED_PROCESSOR_ID = "@prsgoo/processor-news-feed";
export const RECORD_TYPE_NEWS_EVENT = "news.event";
export const VIEW_NEWS_FEED = "news-feed";

export interface NewsFeedItem {
  id: string;
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string;
  source: string;
  summary?: string;
  updatedAt: string;
}

interface NewsEventData {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string;
  source?: string;
  summary?: string;
}

export class NewsFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest: ProcessorPluginManifest = {
    id: NEWS_FEED_PROCESSOR_ID,
    name: "News Feed",
    version: "0.1.0-beta.1",
    kind: PluginKinds.PROCESSOR,
    consumes: [RECORD_TYPE_NEWS_EVENT],
    produces: [VIEW_NEWS_FEED],
  };

  async process(
    records: ReadonlyArray<PulseRecord>,
    context: RuntimeContext,
  ): Promise<PulseViewRecord<NewsFeedItem> | null> {
    const newsRecords = records.filter(
      (r) => r.type === RECORD_TYPE_NEWS_EVENT,
    ) as ReadonlyArray<PulseRecord<NewsEventData>>;

    if (newsRecords.length === 0) {
      context.logger.debug("No news records to process.", {
        pluginId: NEWS_FEED_PROCESSOR_ID,
      });
      return null;
    }

    const latestByKey = new Map<string, PulseRecord<NewsEventData>>();
    for (const record of newsRecords) {
      const key = record.entityKey;
      if (!key) continue;
      const existing = latestByKey.get(key);
      if (!existing || record.timestamp > existing.timestamp) {
        latestByKey.set(key, record);
      }
    }

    const items: NewsFeedItem[] = Array.from(latestByKey.entries())
      .map(([id, r]) => ({
        id,
        title: r.data.title,
        url: r.data.url,
        domain: r.data.domain,
        language: r.data.language,
        sourceCountry: r.data.sourceCountry,
        seenDate: r.data.seenDate,
        source: r.data.source ?? r.source,
        ...(r.data.summary !== undefined && { summary: r.data.summary }),
        updatedAt: r.timestamp,
      }))
      .sort((a, b) => b.seenDate.localeCompare(a.seenDate));

    return {
      view: VIEW_NEWS_FEED,
      generatedAt: context.now().toISOString(),
      items,
    };
  }
}
