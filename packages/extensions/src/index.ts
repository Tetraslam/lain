export { ExtensionRegistry } from "./registry.js";
export { freeformExtension } from "./builtins/freeform.js";
export { worldbuildingExtension } from "./builtins/worldbuilding.js";
export { debateExtension } from "./builtins/debate.js";
export { researchExtension } from "./builtins/research.js";

import { ExtensionRegistry } from "./registry.js";
import { freeformExtension } from "./builtins/freeform.js";
import { worldbuildingExtension } from "./builtins/worldbuilding.js";
import { debateExtension } from "./builtins/debate.js";
import { researchExtension } from "./builtins/research.js";

/**
 * Build the extension registry with all built-in extensions loaded.
 * Single source of truth — used by CLI, TUI, and web server.
 */
export function buildExtensionRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register(freeformExtension);
  registry.register(worldbuildingExtension);
  registry.register(debateExtension);
  registry.register(researchExtension);
  return registry;
}
