import { createHash } from "node:crypto";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginKinds } from "pulsebridge";
import {
  RssIntegrationPlugin,
  RSS_INTEGRATION_ID,
  rssConfigSchema,
} from "../rssIntegrationPlugin.js";

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

function makeOkResponse(text: string) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(""),
    headers: { get: () => null },
  } as unknown as Response;
}

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Earthquake Hits Region</title>
      <link>https://example.com/article1</link>
      <pubDate>Mon, 15 Jan 2024 10:00:00 GMT</pubDate>
      <description>A major earthquake struck the region.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Storm Warning Issued</title>
    <link href="https://atom.example.com/entry1"/>
    <published>2024-01-15T09:00:00Z</published>
    <summary>A severe storm warning was issued.</summary>
  </entry>
</feed>`;

const RSS_NO_URL_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>No URL Item</title>
    </item>
  </channel>
</rss>`;

function sha1Prefix(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 11);
}

describe("RssIntegrationPlugin", () => {
  let plugin: RssIntegrationPlugin;

  beforeEach(() => {
    plugin = new RssIntegrationPlugin();
    plugin.configure({
      feeds: [{ url: "https://feed.example.com/rss", name: "Test Feed" }],
    });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("should expose the expected manifest", () => {
    expect(plugin.manifest).toMatchObject({
      id: RSS_INTEGRATION_ID,
      name: "RSS",
      version: "0.1.0-beta.1",
      kind: PluginKinds.INTEGRATION,
      operations: [
        { id: "fetch-feeds", name: "Fetch Feeds", recordType: "news.event" },
      ],
      auth: { type: "none" },
      polling: { defaultIntervalMs: 300_000, minIntervalMs: 60_000 },
    });
  });

  it("should have manifest id equal to RSS_INTEGRATION_ID constant", () => {
    expect(plugin.manifest.id).toBe(RSS_INTEGRATION_ID);
    expect(RSS_INTEGRATION_ID).toBe("@prsgoo/integration-rss");
  });

  it("should have manifest version 0.1.0", () => {
    expect(plugin.manifest.version).toBe("0.1.0-beta.1");
  });

  it("should have manifest kind INTEGRATION", () => {
    expect(plugin.manifest.kind).toBe(PluginKinds.INTEGRATION);
  });

  it("should have a single operation with id fetch-feeds", () => {
    expect(plugin.manifest.operations).toHaveLength(1);
    expect(plugin.manifest.operations[0]?.id).toBe("fetch-feeds");
  });

  it("should throw on unsupported operationId", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    await expect(
      plugin.execute("unknown-op", makeContext() as never),
    ).rejects.toThrow("not supported");
  });

  it("should map RSS 2.0 item fields correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "news.event",
      source: RSS_INTEGRATION_ID,
      timestamp: "2024-01-15T12:00:00.000Z",
      data: {
        title: "Earthquake Hits Region",
        url: "https://example.com/article1",
        domain: "example.com",
        language: "unknown",
        sourceCountry: "unknown",
        source: "Test Feed",
        summary: "A major earthquake struck the region.",
      },
    });
  });

  it("should parse RSS 2.0 pubDate into ISO seenDate", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records[0]?.data.seenDate).toBe("2024-01-15T10:00:00.000Z");
  });

  it("should produce a SHA-1 entityKey with rss: prefix for RSS items", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    const expected = `rss:${sha1Prefix("https://example.com/article1")}`;
    expect(records[0]?.entityKey).toBe(expected);
    expect(records[0]?.entityKey).toMatch(/^rss:[a-f0-9]{11}$/);
  });

  it("should map Atom 1.0 entry fields correctly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(ATOM_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "news.event",
      source: RSS_INTEGRATION_ID,
      data: {
        title: "Storm Warning Issued",
        url: "https://atom.example.com/entry1",
        domain: "atom.example.com",
        language: "unknown",
        sourceCountry: "unknown",
        seenDate: "2024-01-15T09:00:00.000Z",
        source: "Test Feed",
        summary: "A severe storm warning was issued.",
      },
    });
  });

  it("should produce a SHA-1 entityKey with rss: prefix for Atom entries", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(ATOM_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    const expected = `rss:${sha1Prefix("https://atom.example.com/entry1")}`;
    expect(records[0]?.entityKey).toBe(expected);
    expect(records[0]?.entityKey).toMatch(/^rss:[a-f0-9]{11}$/);
  });

  it("should skip items with no URL", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeOkResponse(RSS_NO_URL_FEED),
    );

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should deduplicate within a poll cycle when same URL appears in two feeds", async () => {
    plugin.configure({
      feeds: [
        { url: "https://feed-a.example.com/rss", name: "Feed A" },
        { url: "https://feed-b.example.com/rss", name: "Feed B" },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(makeOkResponse(RSS_FEED));
    fetchSpy.mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    const urls = records.map((r) => r.data.url);
    const unique = new Set(urls);
    expect(records.length).toBe(unique.size);
    expect(records).toHaveLength(1);
  });

  it("should keep the last-seen source name when deduplicating across feeds", async () => {
    plugin.configure({
      feeds: [
        { url: "https://feed-a.example.com/rss", name: "Feed A" },
        { url: "https://feed-b.example.com/rss", name: "Feed B" },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(makeOkResponse(RSS_FEED));
    fetchSpy.mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records[0]?.data.source).toBe("Feed B");
  });

  it("should warn and continue fetching other feeds when one returns non-200", async () => {
    plugin.configure({
      feeds: [
        { url: "https://bad.example.com/rss", name: "Bad Feed" },
        { url: "https://good.example.com/rss", name: "Good Feed" },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(503));
    fetchSpy.mockResolvedValueOnce(makeOkResponse(RSS_FEED));

    const ctx = makeContext() as never;
    const records = await plugin.execute("fetch-feeds", ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.data.source).toBe("Good Feed");
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.warn.mock.calls[0]?.[0]).toMatch(/Bad Feed/);
  });

  it("should return records only from successful feeds when one fails", async () => {
    plugin.configure({
      feeds: [
        { url: "https://fail.example.com/rss", name: "Fail Feed" },
        { url: "https://ok.example.com/rss", name: "OK Feed" },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500));
    fetchSpy.mockResolvedValueOnce(makeOkResponse(ATOM_FEED));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(1);
    expect(records[0]?.data.source).toBe("OK Feed");
  });

  it("should return empty array when all feeds fail", async () => {
    plugin.configure({
      feeds: [
        { url: "https://fail1.example.com/rss", name: "Fail 1" },
        { url: "https://fail2.example.com/rss", name: "Fail 2" },
      ],
    });

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500));
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(404));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it("should reject config with no feeds", () => {
    expect(() => rssConfigSchema.parse({ feeds: [] })).toThrow();
  });

  it("should reject config with feed missing name", () => {
    expect(() =>
      rssConfigSchema.parse({
        feeds: [{ url: "https://example.com/rss", name: "" }],
      }),
    ).toThrow();
  });

  it("should reject config with invalid feed URL", () => {
    expect(() =>
      rssConfigSchema.parse({ feeds: [{ url: "not-a-url", name: "Feed" }] }),
    ).toThrow();
  });

  it("should set domain to unknown when item URL is not a valid URL", async () => {
    const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel><item>
  <title>Bad URL</title>
  <link>not-a-valid-url</link>
</item></channel></rss>`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(feed));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records[0]?.data.domain).toBe("unknown");
  });

  it("should extract title from Atom title element with attributes", async () => {
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">Article With Type</title>
    <link href="https://example.com/typed-title"/>
    <published>2024-01-15T09:00:00Z</published>
  </entry>
</feed>`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(feed));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records[0]?.data.title).toBe("Article With Type");
  });

  it("should skip Atom entries where link element has no href attribute", async () => {
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>No href</title>
    <link rel="stylesheet"/>
    <published>2024-01-15T09:00:00Z</published>
  </entry>
</feed>`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(feed));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records).toHaveLength(0);
  });

  it("should use empty string title when Atom entry has no title element", async () => {
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://example.com/no-title"/>
    <published>2024-01-15T09:00:00Z</published>
  </entry>
</feed>`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(makeOkResponse(feed));

    const records = await plugin.execute("fetch-feeds", makeContext() as never);

    expect(records[0]?.data.title).toBe("");
  });
});
