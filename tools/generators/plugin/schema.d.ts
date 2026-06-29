export interface PluginGeneratorSchema {
  name: string;
  type: "integration" | "processor";
  description: string;
}
