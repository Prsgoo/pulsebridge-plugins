import type { ProcessorPlugin } from "pulsebridge";

export class NewsFeedProcessorPlugin implements ProcessorPlugin {
  readonly manifest = {
    id: "@prsgoo/processor-news-feed",
    name: "News Feed",
    version: "0.1.0-alpha.1",
    kind: "processor" as const,
    consumes: ["news.event"],
    produces: ["news-feed"],
  };

  async process() {
    return null;
  }
}
