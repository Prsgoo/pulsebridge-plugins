import { describe, it, expect } from "vitest";
import { RssIntegrationPlugin } from "../rssIntegrationPlugin.js";

describe("RssIntegrationPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new RssIntegrationPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/integration-rss");
  });

  it("should return an empty array from execute", async () => {
    const plugin = new RssIntegrationPlugin();
    expect(await plugin.execute()).toEqual([]);
  });
});
