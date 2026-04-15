import type {
  LainExtension,
  NodeContext,
  PlanContext,
  GenerateResponse,
  LifecycleHooks,
  OperationDefinition,
} from "@lain/shared";

/**
 * Manages loaded extensions and dispatches lifecycle hooks.
 * Multiple extensions can be active simultaneously — hooks are called in order.
 */
export class ExtensionRegistry {
  private extensions: Map<string, LainExtension> = new Map();

  /** Register an extension. */
  register(extension: LainExtension): void {
    if (this.extensions.has(extension.name)) {
      throw new Error(`Extension already registered: ${extension.name}`);
    }
    this.extensions.set(extension.name, extension);
  }

  /** Get a registered extension by name. */
  get(name: string): LainExtension | undefined {
    return this.extensions.get(name);
  }

  /** Get all registered extensions. */
  getAll(): LainExtension[] {
    return Array.from(this.extensions.values());
  }

  /** Get names of all registered extensions. */
  names(): string[] {
    return Array.from(this.extensions.keys());
  }

  // ========================================================================
  // Prompt injection
  // ========================================================================

  /** Collect system prompt fragments from all active extensions. */
  getSystemPrompt(context: NodeContext, activeExtensions?: string[]): string {
    const parts: string[] = [];
    for (const ext of this.iterActive(activeExtensions)) {
      if (ext.systemPrompt) {
        const fragment = ext.systemPrompt(context);
        if (fragment) parts.push(fragment);
      }
    }
    return parts.join("\n\n");
  }

  /** Collect plan prompt fragments from all active extensions. */
  getPlanPrompt(context: PlanContext, activeExtensions?: string[]): string {
    const parts: string[] = [];
    for (const ext of this.iterActive(activeExtensions)) {
      if (ext.planPrompt) {
        const fragment = ext.planPrompt(context);
        if (fragment) parts.push(fragment);
      }
    }
    return parts.join("\n\n");
  }

  // ========================================================================
  // Lifecycle hooks
  // ========================================================================

  /** Run a lifecycle hook across all active extensions. */
  async runHook<K extends keyof LifecycleHooks>(
    hook: K,
    ...args: Parameters<LifecycleHooks[K]>
  ): Promise<void> {
    for (const ext of this.extensions.values()) {
      const fn = ext.hooks?.[hook];
      if (fn) {
        await (fn as (...a: unknown[]) => unknown)(...args);
      }
    }
  }

  /**
   * Run the after:plan hook — extensions can modify the directions list.
   * Returns the (potentially modified) directions.
   */
  async runAfterPlan(
    context: PlanContext,
    directions: string[],
    activeExtensions?: string[]
  ): Promise<string[]> {
    let result = directions;
    for (const ext of this.iterActive(activeExtensions)) {
      const fn = ext.hooks?.["after:plan"];
      if (fn) {
        result = await fn(context, result) || result;
      }
    }
    return result;
  }

  /**
   * Run the after:generate hook — extensions can modify the response.
   * Returns the (potentially modified) response.
   */
  async runAfterGenerate(
    context: NodeContext,
    response: GenerateResponse,
    activeExtensions?: string[]
  ): Promise<GenerateResponse> {
    let result = response;
    for (const ext of this.iterActive(activeExtensions)) {
      const fn = ext.hooks?.["after:generate"];
      if (fn) {
        result = await fn(context, result) || result;
      }
    }
    return result;
  }

  // ========================================================================
  // Validators
  // ========================================================================

  /** Run all validators for a given phase. Returns errors if any. */
  runValidators(
    phase: "before:generate" | "after:generate",
    context: NodeContext,
    response?: GenerateResponse,
    activeExtensions?: string[]
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const ext of this.iterActive(activeExtensions)) {
      if (!ext.validators) continue;
      for (const validator of ext.validators) {
        if (validator.phase !== phase) continue;
        const result = validator.validate(context, response);
        if (!result.valid) {
          errors.push(`[${ext.name}/${validator.name}] ${result.message || "Validation failed"}`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  // ========================================================================
  // Custom operations
  // ========================================================================

  /** Get all custom operations from all extensions. */
  getAllOperations(): { extension: string; op: OperationDefinition }[] {
    const ops: { extension: string; op: OperationDefinition }[] = [];
    for (const ext of this.extensions.values()) {
      if (ext.operations) {
        for (const op of ext.operations) {
          ops.push({ extension: ext.name, op });
        }
      }
    }
    return ops;
  }

  // ========================================================================
  // Custom renderers
  // ========================================================================

  /** Try to render a node with extension-specific renderers. Returns undefined if no renderer handles it. */
  renderNode(node: Parameters<NonNullable<LainExtension["renderer"]>>[0], activeExtensions?: string[]): string | undefined {
    for (const ext of this.iterActive(activeExtensions)) {
      if (ext.renderer) {
        const result = ext.renderer(node);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private *iterActive(activeExtensions?: string[]): Iterable<LainExtension> {
    if (!activeExtensions) {
      yield* this.extensions.values();
      return;
    }
    for (const name of activeExtensions) {
      const ext = this.extensions.get(name);
      if (ext) yield ext;
    }
  }
}
