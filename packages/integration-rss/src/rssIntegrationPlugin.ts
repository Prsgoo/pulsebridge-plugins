import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  PluginKinds,
  TransientError,
  type IntegrationPlugin,
  type IntegrationPluginManifest,
  type PulseRecord,
  type RuntimeContext,
} from "pulsebridge";

export const RSS_INTEGRATION_ID = "@prsgoo/integration-rss";

export const rssConfigSchema = z.object({
  feeds: z
    .array(z.object({ url: z.string().url(), name: z.string().min(1) }))
    .min(1),
});

export type RssConfig = z.infer<typeof rssConfigSchema>;

export interface RssNewsEventData {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string;
  source: string;
  summary?: string;
}

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function sha1Prefix(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 11);
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function resolveTitle(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && "#text" in raw) {
    return String((raw as Record<string, unknown>)["#text"]);
  }
  return String(raw ?? "");
}

function resolveAtomUrl(link: unknown): string | undefined {
  if (typeof link === "string") return link;
  if (link !== null && typeof link === "object") {
    const href = (link as Record<string, unknown>)["@_href"];
    if (typeof href === "string") return href;
  }
  return undefined;
}

function toIso(dateStr: string | undefined): string {
  if (!dateStr) return new Date(0).toISOString();
  return new Date(dateStr).toISOString();
}

function parseRssItems(
  xml: unknown,
  feedName: string,
  now: string,
): Map<string, PulseRecord<RssNewsEventData>> {
  const records = new Map<string, PulseRecord<RssNewsEventData>>();
  const parsed = xml as Record<string, unknown>;
  const channel = (parsed["rss"] as Record<string, unknown>)?.["channel"] as
    | Record<string, unknown>
    | undefined;
  if (!channel) return records;

  const rawItems = channel["item"];
  const items: unknown[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems !== undefined
      ? [rawItems]
      : [];

  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const url = typeof item["link"] === "string" ? item["link"] : undefined;
    if (!url) continue;

    const record: PulseRecord<RssNewsEventData> = {
      type: "news.event",
      timestamp: now,
      source: RSS_INTEGRATION_ID,
      entityKey: `rss:${sha1Prefix(url)}`,
      data: {
        title: String(item["title"] ?? ""),
        url,
        domain: domainFromUrl(url),
        language: "unknown",
        sourceCountry: "unknown",
        seenDate: toIso(item["pubDate"] as string | undefined),
        source: feedName,
        ...(item["description"] !== undefined
          ? { summary: String(item["description"]) }
          : {}),
      },
    };
    records.set(url, record);
  }

  return records;
}

function parseAtomEntries(
  xml: unknown,
  feedName: string,
  now: string,
): Map<string, PulseRecord<RssNewsEventData>> {
  const records = new Map<string, PulseRecord<RssNewsEventData>>();
  const parsed = xml as Record<string, unknown>;
  const feed = parsed["feed"] as Record<string, unknown> | undefined;
  if (!feed) return records;

  const rawEntries = feed["entry"];
  const entries: unknown[] = Array.isArray(rawEntries)
    ? rawEntries
    : rawEntries !== undefined
      ? [rawEntries]
      : [];

  for (const raw of entries) {
    const entry = raw as Record<string, unknown>;
    const url = resolveAtomUrl(entry["link"]);
    if (!url) continue;

    const seenDate = toIso(
      (entry["published"] as string | undefined) ??
        (entry["updated"] as string | undefined),
    );

    const record: PulseRecord<RssNewsEventData> = {
      type: "news.event",
      timestamp: now,
      source: RSS_INTEGRATION_ID,
      entityKey: `rss:${sha1Prefix(url)}`,
      data: {
        title: resolveTitle(entry["title"]),
        url,
        domain: domainFromUrl(url),
        language: "unknown",
        sourceCountry: "unknown",
        seenDate,
        source: feedName,
        ...(entry["summary"] !== undefined
          ? { summary: String(entry["summary"]) }
          : {}),
      },
    };
    records.set(url, record);
  }

  return records;
}

function parseFeed(
  text: string,
  feedName: string,
  now: string,
): Map<string, PulseRecord<RssNewsEventData>> {
  const xml = XML_PARSER.parse(text) as unknown;
  if (text.includes("<rss")) {
    return parseRssItems(xml, feedName, now);
  }
  return parseAtomEntries(xml, feedName, now);
}

export class RssIntegrationPlugin implements IntegrationPlugin<RssConfig> {
  readonly manifest: IntegrationPluginManifest = {
    id: RSS_INTEGRATION_ID,
    name: "RSS",
    version: "0.1.0",
    kind: PluginKinds.INTEGRATION,
    operations: [
      { id: "fetch-feeds", name: "Fetch Feeds", recordType: "news.event" },
    ],
    auth: { type: "none" },
    polling: { defaultIntervalMs: 300_000, minIntervalMs: 60_000 },
  };

  readonly configSchema = rssConfigSchema;

  private config: RssConfig = {
    feeds: [{ url: "https://example.com/rss", name: "default" }],
  };

  configure(config: RssConfig): void {
    this.config = config;
  }

  async execute(
    operationId: string,
    context: RuntimeContext,
  ): Promise<ReadonlyArray<PulseRecord<RssNewsEventData>>> {
    if (operationId !== "fetch-feeds") {
      throw new Error(
        `Operation '${operationId}' is not supported by plugin '${this.manifest.id}'.`,
      );
    }

    const now = context.now().toISOString();
    const merged = new Map<string, PulseRecord<RssNewsEventData>>();

    for (const feed of this.config.feeds) {
      let response: Response;
      try {
        response = await fetch(feed.url, { signal: context.signal ?? null });
        if (!response.ok) {
          throw new TransientError(
            `Feed '${feed.name}' returned HTTP ${response.status}.`,
          );
        }
      } catch (err) {
        context.logger.warn(
          `[integration-rss] Failed to fetch feed '${feed.name}': ${String(err)}`,
        );
        continue;
      }

      const text = await response.text();
      const records = parseFeed(text, feed.name, now);
      for (const [url, record] of records) {
        merged.set(url, record);
      }
    }

    return Array.from(merged.values());
  }
}
