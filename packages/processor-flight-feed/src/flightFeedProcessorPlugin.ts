import type { ProcessorPlugin } from "pulsebridge";

export class FlightFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest = {
    id: "@prsgoo/processor-flight-feed",
    name: "Flight Feed",
    version: "0.1.0-alpha.1",
    kind: "processor" as const,
    consumes: ["flight.position"],
    produces: ["flight-feed"],
  };

  async process() {
    return null;
  }
}
