import { describe, it, expect } from "vitest";
import { WildfireFeedProcessorPlugin } from "../wildfireFeedProcessorPlugin.js";

describe("WildfireFeedProcessorPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new WildfireFeedProcessorPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/processor-wildfire-feed");
  });

  it("should return null from process", async () => {
    const plugin = new WildfireFeedProcessorPlugin();
    expect(await plugin.process()).toBeNull();
  });
});
