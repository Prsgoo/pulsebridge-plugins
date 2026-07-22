import { describe, it, expect } from "vitest";
import { FlightFeedProcessorPlugin } from "../flightFeedProcessorPlugin.js";

describe("FlightFeedProcessorPlugin", () => {
  it("should expose the correct manifest id", () => {
    const plugin = new FlightFeedProcessorPlugin();
    expect(plugin.manifest.id).toBe("@prsgoo/processor-flight-feed");
  });

  it("should return null from process", async () => {
    const plugin = new FlightFeedProcessorPlugin();
    expect(await plugin.process()).toBeNull();
  });
});
