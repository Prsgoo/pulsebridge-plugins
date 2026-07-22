import type { ProcessorPlugin } from "pulsebridge";

export class WildfireFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest = {
    id: "@prsgoo/processor-wildfire-feed",
    name: "Wildfire Feed",
    version: "0.1.0-alpha.1",
    kind: "processor" as const,
    consumes: ["wildfire.event"],
    produces: ["wildfire-feed"],
  };

  async process() {
    return null;
  }
}
