import {
  generateFiles,
  joinPathFragments,
  names,
  workspaceRoot,
  type Tree,
} from "@nx/devkit";
import type { PluginGeneratorSchema } from "./schema.d.ts";

export default function pluginGenerator(
  tree: Tree,
  options: PluginGeneratorSchema,
): void {
  const pluginNames = names(options.name);
  const typeNames = names(options.type);

  const packageName = `@prsgoo/${options.type}-${pluginNames.fileName}`;
  const packageDir = joinPathFragments(
    "packages",
    `${options.type}-${pluginNames.fileName}`,
  );

  generateFiles(
    tree,
    joinPathFragments(
      workspaceRoot,
      "tools/generators/plugin/files",
      options.type,
    ),
    packageDir,
    {
      tmpl: "",
      name: options.name,
      description: options.description,
      packageName,
      pluginId: packageName,
      /** Full class name: e.g. SmokeTestIntegrationPlugin */
      className: `${pluginNames.className}${typeNames.className}Plugin`,
      /** Name portion only (PascalCase): e.g. SmokeTest — use for display names and type aliases */
      pluginClassName: pluginNames.className,
      propertyName: pluginNames.propertyName,
      constantName: pluginNames.constantName,
      fileName: pluginNames.fileName,
    },
  );
}
