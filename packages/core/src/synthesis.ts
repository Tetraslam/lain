import { Storage } from "./storage.js";
import { Graph } from "./graph.js";
import type { ExtensionRegistryLike } from "./orchestrator.js";
import type {
  AgentProvider,
  LainEvent,
  LainEventHandler,
  Synthesis,
  SynthesisAnnotation,
  SynthesizeResponse,
  SynthesisDiff,
  SynthesisDiffChange,
  MergePreview,
  NodeAnnotation,
} from "@lain/shared";
import { generateId, nowISO, buildMergeGenerationPrompt, parseMergeGenerationResponse } from "@lain/shared";

export interface SynthesisEngineOptions {
  storage: Storage;
  graph?: Graph;
  agent: AgentProvider | null;
  extensions?: ExtensionRegistryLike;
  onEvent?: LainEventHandler;
}

/**
 * Manages synthesis passes: sends the full graph to the agent,
 * stores the resulting annotations, and handles merging.
 */
export class SynthesisEngine {
  private storage: Storage;
  private graph: Graph;
  private agent: AgentProvider | null;
  private extensions: ExtensionRegistryLike | null;
  private onEvent: LainEventHandler;

  constructor(options: SynthesisEngineOptions) {
    this.storage = options.storage;
    this.graph = options.graph ?? new Graph(this.storage);
    this.agent = options.agent;
    this.extensions = options.extensions ?? null;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /**
   * Run a synthesis pass on an exploration.
   *
   * 1. Creates a pending synthesis record
   * 2. Sends the full graph to the synthesis agent
   * 3. Parses the response into typed annotations
   * 4. Stores everything (staged — not applied to the graph)
   *
   * Returns the synthesis ID.
   */
  async synthesize(explorationId: string): Promise<string> {
    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    // Clean up any orphaned pending syntheses before starting a new one
    this.cleanupOrphaned(explorationId);

    const nodes = this.graph.getAllNodes(explorationId);
    const activeNodes = nodes.filter((n) => n.status !== "pruned");
    if (activeNodes.length === 0) {
      throw new Error("No active nodes to synthesize.");
    }

    const crosslinks = this.graph.getCrosslinks(explorationId);

    // Create pending synthesis record
    const synthesisId = `synth-${generateId()}`;
    const now = nowISO();
    const synthesis: Synthesis = {
      id: synthesisId,
      explorationId,
      content: "",
      model: null,
      status: "pending",
      merged: false,
      createdAt: now,
    };
    this.storage.createSynthesis(synthesis);

    this.emit({
      type: "synthesis:started",
      explorationId,
      data: { synthesisId },
    });

    // Run before:synthesize hook
    if (this.extensions) {
      await this.extensions.runHook("before:synthesize", explorationId);
    }

    // Call the synthesis agent
    if (!this.agent) throw new Error("Agent is required for synthesis. Pass an agent to SynthesisEngine.");
    const response = await this.agent.synthesize({
      exploration,
      nodes: activeNodes,
      crosslinks,
    });

    // Run after:synthesize hook
    if (this.extensions) {
      await this.extensions.runHook("after:synthesize", explorationId);
    }

    // Update synthesis with content
    this.storage.updateSynthesisContent(
      synthesisId,
      response.summary,
      response.model
    );

    // Store annotations
    for (const annotationData of response.annotations) {
      // Validate node references exist
      if (annotationData.sourceNodeId) {
        const sourceNode = this.graph.getNode(annotationData.sourceNodeId);
        if (!sourceNode) continue; // skip annotations referencing nonexistent nodes
      }
      if (annotationData.targetNodeId) {
        const targetNode = this.graph.getNode(annotationData.targetNodeId);
        if (!targetNode) continue;
      }

      // Skip crosslink suggestions that already exist
      if (annotationData.type === "crosslink" && annotationData.sourceNodeId && annotationData.targetNodeId) {
        const existing = crosslinks.find(
          (cl) =>
            (cl.sourceId === annotationData.sourceNodeId && cl.targetId === annotationData.targetNodeId) ||
            (cl.sourceId === annotationData.targetNodeId && cl.targetId === annotationData.sourceNodeId)
        );
        if (existing) continue;
      }

      const annotation: SynthesisAnnotation = {
        id: `ann-${generateId()}`,
        synthesisId,
        type: annotationData.type,
        sourceNodeId: annotationData.sourceNodeId ?? null,
        targetNodeId: annotationData.targetNodeId ?? null,
        content: annotationData.content ?? null,
        merged: false,
        createdAt: now,
      };
      this.storage.createAnnotation(annotation);
    }

    this.emit({
      type: "synthesis:complete",
      explorationId,
      data: { synthesisId, annotationCount: response.annotations.length },
    });

    return synthesisId;
  }

  /**
   * Get a synthesis and its annotations.
   */
  getSynthesis(synthesisId: string): {
    synthesis: Synthesis;
    annotations: SynthesisAnnotation[];
  } | null {
    const synthesis = this.storage.getSynthesis(synthesisId);
    if (!synthesis) return null;
    const annotations = this.storage.getAnnotationsForSynthesis(synthesisId);
    return { synthesis, annotations };
  }

  /**
   * Get all syntheses for an exploration.
   */
  getSyntheses(explorationId: string): Synthesis[] {
    return this.storage.getSynthesesForExploration(explorationId);
  }

  /**
   * Compute what a merge would do — returns a diff describing all changes.
   * For crosslink/note: immediate (no agent call needed).
   * For contradiction/merge_suggestion: requires a pre-generated MergePreview.
   */
  computeDiff(annotationId: string, preview?: MergePreview): SynthesisDiff {
    const annotation = this.storage.getAnnotation(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);

    const changes: SynthesisDiffChange[] = [];

    if (annotation.type === "crosslink") {
      const sourceNode = annotation.sourceNodeId ? this.graph.getNode(annotation.sourceNodeId) : null;
      const targetNode = annotation.targetNodeId ? this.graph.getNode(annotation.targetNodeId) : null;
      changes.push({
        type: "add_crosslink",
        sourceId: annotation.sourceNodeId || "",
        sourceTitle: sourceNode?.title || annotation.sourceNodeId || "",
        targetId: annotation.targetNodeId || "",
        targetTitle: targetNode?.title || annotation.targetNodeId || "",
        label: annotation.content,
      });
    } else if (annotation.type === "note") {
      const sourceNode = annotation.sourceNodeId ? this.graph.getNode(annotation.sourceNodeId) : null;
      changes.push({
        type: "add_note",
        nodeId: annotation.sourceNodeId || "",
        nodeTitle: sourceNode?.title || annotation.sourceNodeId || "",
        content: annotation.content || "",
      });
    } else if ((annotation.type === "contradiction" || annotation.type === "merge_suggestion") && preview) {
      const parentNode = this.graph.getNode(preview.parentId);
      changes.push({
        type: "add_node",
        title: preview.title,
        content: preview.content,
        parentId: preview.parentId,
        parentTitle: parentNode?.title || preview.parentId,
        crosslinkTo: preview.crosslinkTo.map((id) => {
          const n = this.graph.getNode(id);
          return { id, title: n?.title || id };
        }),
      });
    }

    return { annotationId, annotationType: annotation.type, changes };
  }

  /**
   * Merge all unmerged annotations from a synthesis into the graph.
   * Note: for contradiction/merge_suggestion, this only does immediate merges
   * (crosslinks + notes). Use generateMergePreview + applyMergePreview for
   * annotations that require agent generation.
   *
   * Returns the number of annotations merged.
   */
  mergeAll(synthesisId: string): { merged: number; skipped: number } {
    const synthesis = this.storage.getSynthesis(synthesisId);
    if (!synthesis) throw new Error(`Synthesis not found: ${synthesisId}`);

    const unmerged = this.storage.getUnmergedAnnotations(synthesisId);
    let mergedCount = 0;
    let skippedCount = 0;

    this.storage.transaction(() => {
      for (const annotation of unmerged) {
        // contradiction and merge_suggestion require preview generation — skip them
        if (annotation.type === "contradiction" || annotation.type === "merge_suggestion") {
          skippedCount++;
          continue;
        }
        this.mergeAnnotationImmediate(annotation);
        mergedCount++;
      }

      // Only mark synthesis as fully merged if no annotations were skipped
      if (skippedCount === 0) {
        this.storage.markSynthesisMerged(synthesisId);
      }
    });

    return { merged: mergedCount, skipped: skippedCount };
  }

  /**
   * Merge a single annotation by ID (immediate — for crosslink and note types).
   * For contradiction/merge_suggestion, use generateMergePreview first.
   */
  mergeSingle(annotationId: string): void {
    const annotation = this.storage.getAnnotation(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
    if (annotation.merged) throw new Error(`Annotation already merged: ${annotationId}`);

    this.mergeAnnotationImmediate(annotation);
  }

  /**
   * Generate a preview for merging a contradiction or merge_suggestion.
   * Returns proposed content that the user can review before applying.
   * Requires an agent (will throw if agent is null).
   */
  async generateMergePreview(annotationId: string, explorationId: string): Promise<MergePreview> {
    const annotation = this.storage.getAnnotation(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
    if (annotation.type !== "contradiction" && annotation.type !== "merge_suggestion") {
      throw new Error(`Preview only supported for contradiction/merge_suggestion, got: ${annotation.type}`);
    }
    if (!this.agent) throw new Error("Agent required for merge preview generation");

    const sourceNode = annotation.sourceNodeId ? this.graph.getNode(annotation.sourceNodeId) : null;
    const targetNode = annotation.targetNodeId ? this.graph.getNode(annotation.targetNodeId) : null;
    if (!sourceNode || !targetNode) throw new Error("Source or target node not found");

    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    // Build prompt and call agent with raw system/user (no synthesis wrapping)
    const { system, user } = buildMergeGenerationPrompt({
      type: annotation.type as "contradiction" | "merge_suggestion",
      sourceNode,
      targetNode,
      annotationContent: annotation.content || "",
      explorationSeed: exploration.seed,
    });

    const rawResponse = await this.agent.generateRaw(system, user, 2048);
    const parsed = parseMergeGenerationResponse(rawResponse);

    // Determine parent: lowest common ancestor of source and target
    // Include both nodes themselves in the ancestor sets for proper LCA
    const sourceAncestors = [sourceNode, ...this.graph.getAncestorChain(sourceNode.id)];
    const targetAncestors = [targetNode, ...this.graph.getAncestorChain(targetNode.id)];
    const sourceAncIds = new Set(sourceAncestors.map((n) => n.id));

    // Find first target ancestor that's also a source ancestor
    let lca = exploration.id === sourceNode.explorationId
      ? (this.graph.getAllNodes(explorationId).find((n) => n.parentId === null)?.id || sourceNode.id)
      : sourceNode.id;
    for (const anc of targetAncestors) {
      if (sourceAncIds.has(anc.id)) { lca = anc.id; break; }
    }

    return {
      title: parsed.title,
      content: parsed.content,
      parentId: lca,
      crosslinkTo: [sourceNode.id, targetNode.id],
    };
  }

  /**
   * Apply a merge preview — creates the node and crosslinks it to the source/target.
   * Call this after the user reviews and accepts the preview.
   */
  applyMergePreview(
    annotationId: string,
    explorationId: string,
    preview: MergePreview
  ): string {
    const annotation = this.storage.getAnnotation(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);

    // Create the new node
    const nodeId = generateId();
    const parentNode = this.graph.getNode(preview.parentId);
    const siblings = parentNode
      ? this.graph.getAllNodes(explorationId).filter((n) => n.parentId === preview.parentId && n.status !== "pruned")
      : [];
    const now = nowISO();

    this.storage.createNode({
      id: nodeId,
      explorationId,
      parentId: preview.parentId,
      depth: parentNode ? parentNode.depth + 1 : 1,
      branchIndex: siblings.length,
      status: "complete",
      title: preview.title,
      content: preview.content,
      contentConflict: null,
      planSummary: annotation.type === "contradiction" ? "Resolution of contradiction" : "Synthesis of merged branches",
      model: "synthesis",
      provider: "synthesis",
      extensionData: null,
      createdAt: now,
      updatedAt: now,
    });

    // Crosslink to both source and target
    for (const targetId of preview.crosslinkTo) {
      this.graph.addCrosslink(nodeId, targetId, annotation.type === "contradiction" ? "resolves" : "synthesizes", true);
    }

    // Mark annotation as merged
    this.storage.markAnnotationMerged(annotationId);

    return nodeId;
  }

  /**
   * Dismiss (skip) a single annotation without applying it.
   */
  dismissAnnotation(annotationId: string): void {
    const annotation = this.storage.getAnnotation(annotationId);
    if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);

    // Mark as merged (consumed) without applying
    this.storage.markAnnotationMerged(annotationId);
  }

  /**
   * Get node annotations (persistent notes) for a given node.
   */
  getNodeAnnotations(nodeId: string): NodeAnnotation[] {
    return this.storage.getNodeAnnotations(nodeId);
  }

  /**
   * Clean up orphaned synthesis records (pending syntheses that never completed).
   * Called automatically before new synthesis runs.
   */
  cleanupOrphaned(explorationId: string): number {
    const syntheses = this.storage.getSynthesesForExploration(explorationId);
    let cleaned = 0;
    for (const synth of syntheses) {
      if (synth.status === "pending") {
        // Delete annotations for this orphaned synthesis
        const annotations = this.storage.getAnnotationsForSynthesis(synth.id);
        for (const ann of annotations) {
          this.storage.markAnnotationMerged(ann.id); // mark as consumed to avoid re-processing
        }
        this.storage.updateSynthesisStatus(synth.id, "complete");
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Internal: apply a single annotation immediately (no agent call needed).
   */
  private mergeAnnotationImmediate(annotation: SynthesisAnnotation): void {
    if (annotation.type === "crosslink") {
      if (annotation.sourceNodeId && annotation.targetNodeId) {
        this.graph.addCrosslink(
          annotation.sourceNodeId,
          annotation.targetNodeId,
          annotation.content ?? undefined,
          true
        );
      }
    } else if (annotation.type === "note") {
      // Attach as a persistent note on the source node
      if (annotation.sourceNodeId && annotation.content) {
        const nodeAnnotation: NodeAnnotation = {
          id: `na-${generateId()}`,
          nodeId: annotation.sourceNodeId,
          content: annotation.content,
          source: "synthesis",
          synthesisAnnotationId: annotation.id,
          createdAt: nowISO(),
        };
        this.storage.createNodeAnnotation(nodeAnnotation);
      }
    }
    // For contradiction/merge_suggestion merged via mergeAll:
    // just mark as consumed (they need generateMergePreview for full effect)

    this.storage.markAnnotationMerged(annotation.id);
  }

  private emit(event: Omit<LainEvent, "timestamp">): void {
    this.onEvent({ ...event, timestamp: nowISO() } as LainEvent);
  }
}
