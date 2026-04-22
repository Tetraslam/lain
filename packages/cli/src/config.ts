/**
 * CLI config — re-exports from @lain/shared config module.
 * This file exists for backward compatibility with CLI command imports.
 */
export {
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
  saveWorkspaceConfig,
  configExists,
  slugify,
  type Credentials,
} from "@lain/shared";
