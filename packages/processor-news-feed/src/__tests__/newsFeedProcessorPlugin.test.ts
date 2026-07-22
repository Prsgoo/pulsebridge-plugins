import { describe, it, expect } from "vitest";
import { NewsFeedProcessorPlugin } from "../newsFeedProcessorPlugin.js";

describe("NewsFeedProcessorPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new NewsFeedProcessorPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/processor-news-feed");
  });

  it("should return null from process", async () => {
    const plugin = new NewsFeedProcessorPlugin();
    expect(await plugin.process()).toBeNull();
  });
});
