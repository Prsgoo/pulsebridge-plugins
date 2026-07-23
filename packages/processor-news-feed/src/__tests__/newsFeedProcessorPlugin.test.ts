import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PulseRecord, RuntimeContext } from "pulsebridge";
import {
  NewsFeedProcessorPlugin,
  NEWS_FEED_PROCESSOR_ID,
  VIEW_NEWS_FEED,
} from "../newsFeedProcessorPlugin.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeContext(): RuntimeContext {
  return {
    logger: mockLogger,
    now: () => new Date("2024-06-01T12:00:00Z"),
    secrets: { get: () => undefined, has: () => false },
  } as unknown as RuntimeContext;
}

function makeNewsRecord(
  entityKey: string,
  opts: {
    timestamp?: string;
    title?: string;
    url?: string;
    domain?: string;
    language?: string;
    sourceCountry?: string;
    seenDate?: string;
    source?: string;
    dataSource?: string;
    summary?: string;
  } = {},
): PulseRecord {
  return {
    type: "news.event",
    timestamp: opts.timestamp ?? "2024-06-01T11:00:00Z",
    source: opts.source ?? "@prsgoo/integration-gdelt",
    entityKey,
    data: {
      title: opts.title ?? "Breaking News",
      url: opts.url ?? `https://example.com/${entityKey}`,
      domain: opts.domain ?? "example.com",
      language: opts.language ?? "English",
      sourceCountry: opts.sourceCountry ?? "US",
      seenDate: opts.seenDate ?? "2024-06-01T10:00:00Z",
      ...(opts.dataSource !== undefined && { source: opts.dataSource }),
      ...(opts.summary !== undefined && { summary: opts.summary }),
    },
  };
}

describe("NewsFeedProcessorPlugin", () => {
  let plugin: NewsFeedProcessorPlugin;

  beforeEach(() => {
    plugin = new NewsFeedProcessorPlugin();
    vi.clearAllMocks();
  });

  it("should produce a news-feed view from news.event records", async () => {
    const view = await plugin.process(
      [makeNewsRecord("article-1")],
      makeContext(),
    );
    expect(view).not.toBeNull();
    expect(view?.view).toBe(VIEW_NEWS_FEED);
    expect(view?.items).toHaveLength(1);
  });

  it("should return null when records array is empty", async () => {
    const view = await plugin.process([], makeContext());
    expect(view).toBeNull();
  });

  it("should return null when records contain no news.event type", async () => {
    const unrelated: PulseRecord = {
      type: "seismic.event",
      timestamp: "2024-06-01T11:00:00Z",
      source: "other",
      data: {},
    };
    const view = await plugin.process([unrelated], makeContext());
    expect(view).toBeNull();
  });

  it("should deduplicate by entityKey keeping the latest record", async () => {
    const older = makeNewsRecord("article-1", {
      timestamp: "2024-06-01T10:00:00Z",
      title: "Old Title",
    });
    const newer = makeNewsRecord("article-1", {
      timestamp: "2024-06-01T11:00:00Z",
      title: "New Title",
    });
    const view = await plugin.process([older, newer], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.title).toBe("New Title");
  });

  it("should keep newest when older record arrives after newer in same batch", async () => {
    const newer = makeNewsRecord("article-1", {
      timestamp: "2024-06-01T11:00:00Z",
      title: "New Title",
    });
    const older = makeNewsRecord("article-1", {
      timestamp: "2024-06-01T10:00:00Z",
      title: "Old Title",
    });
    const view = await plugin.process([newer, older], makeContext());
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.title).toBe("New Title");
  });

  it("should sort items by seenDate descending", async () => {
    const records = [
      makeNewsRecord("article-1", { seenDate: "2024-06-01T08:00:00Z" }),
      makeNewsRecord("article-2", { seenDate: "2024-06-01T10:00:00Z" }),
      makeNewsRecord("article-3", { seenDate: "2024-06-01T09:00:00Z" }),
    ];
    const view = await plugin.process(records, makeContext());
    expect(view?.items.map((i) => i.id)).toEqual([
      "article-2",
      "article-3",
      "article-1",
    ]);
  });

  it("should map all NewsFeedItem fields correctly", async () => {
    const record = makeNewsRecord("article-abc", {
      title: "Major Earthquake Hits Region",
      url: "https://news.example.com/quake",
      domain: "news.example.com",
      language: "French",
      sourceCountry: "FR",
      seenDate: "2024-06-01T09:30:00Z",
      source: "@prsgoo/integration-gdelt",
      summary: "A major earthquake struck the region early morning.",
      timestamp: "2024-06-01T11:30:00Z",
    });
    const view = await plugin.process([record], makeContext());
    const item = view?.items[0];
    expect(item?.id).toBe("article-abc");
    expect(item?.title).toBe("Major Earthquake Hits Region");
    expect(item?.url).toBe("https://news.example.com/quake");
    expect(item?.domain).toBe("news.example.com");
    expect(item?.language).toBe("French");
    expect(item?.sourceCountry).toBe("FR");
    expect(item?.seenDate).toBe("2024-06-01T09:30:00Z");
    expect(item?.source).toBe("@prsgoo/integration-gdelt");
    expect(item?.summary).toBe(
      "A major earthquake struck the region early morning.",
    );
    expect(item?.updatedAt).toBe("2024-06-01T11:30:00Z");
  });

  it("should fall back to record.source when data.source is absent", async () => {
    const record = makeNewsRecord("article-1", {
      source: "@prsgoo/integration-gdelt",
    });
    const view = await plugin.process([record], makeContext());
    expect(view?.items[0]?.source).toBe("@prsgoo/integration-gdelt");
  });

  it("should use data.source (feed name) when present", async () => {
    const record = makeNewsRecord("article-1", {
      source: "@prsgoo/integration-rss",
      dataSource: "BBC World News",
    });
    const view = await plugin.process([record], makeContext());
    expect(view?.items[0]?.source).toBe("BBC World News");
  });

  it("should set view field to news-feed", async () => {
    const view = await plugin.process(
      [makeNewsRecord("article-1")],
      makeContext(),
    );
    expect(view?.view).toBe("news-feed");
  });

  it("should set generatedAt to context.now() ISO string", async () => {
    const view = await plugin.process(
      [makeNewsRecord("article-1")],
      makeContext(),
    );
    expect(view?.generatedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("should log debug message when no news records are present", async () => {
    await plugin.process([], makeContext());
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "No news records to process.",
      { pluginId: NEWS_FEED_PROCESSOR_ID },
    );
  });

  it("should expose the correct manifest id", () => {
    expect(plugin.manifest.id).toBe(NEWS_FEED_PROCESSOR_ID);
  });

  it("should expose processor kind in manifest", () => {
    expect(plugin.manifest.kind).toBe("processor");
  });

  it("should declare news.event in manifest consumes", () => {
    expect(plugin.manifest.consumes).toContain("news.event");
  });

  it("should declare news-feed in manifest produces", () => {
    expect(plugin.manifest.produces).toContain("news-feed");
  });
});
