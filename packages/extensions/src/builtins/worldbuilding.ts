import type { LainExtension, NodeContext, PlanContext } from "@lain/shared";

/**
 * Worldbuilding extension — shapes generation toward structured worldbuilding.
 * Injects prompts for geography, cultures, history, magic systems, etc.
 * Adds custom node types and custom operations.
 */
export const worldbuildingExtension: LainExtension = {
  name: "worldbuilding",
  version: "0.1.0",

  configSchema: [
    {
      key: "genre",
      type: "select",
      description: "Genre of the world being built",
      default: "fantasy",
      options: [
        { value: "fantasy", label: "Fantasy" },
        { value: "scifi", label: "Science Fiction" },
        { value: "historical", label: "Historical / Alternate History" },
        { value: "contemporary", label: "Contemporary / Realistic" },
        { value: "cosmic", label: "Cosmic / Mythic" },
      ],
    },
    {
      key: "detail_focus",
      type: "select",
      description: "What aspects to emphasize",
      default: "balanced",
      options: [
        { value: "balanced", label: "Balanced" },
        { value: "cultures", label: "Cultures & Societies" },
        { value: "geography", label: "Geography & Ecology" },
        { value: "history", label: "History & Timeline" },
        { value: "magic", label: "Magic / Technology Systems" },
        { value: "politics", label: "Politics & Power Structures" },
      ],
    },
  ],

  systemPrompt(context: NodeContext): string {
    const depth = context.depth;

    const basePrompt = [
      "You are a worldbuilding engine. You create rich, internally consistent fictional worlds.",
      "",
      "Worldbuilding rules:",
      "- Every element should have causal connections to other elements (geography shapes culture, economy shapes politics, etc.)",
      "- Be specific: name places, people, concepts. Use invented terminology where appropriate.",
      "- Consider second-order effects: if X exists, what does that imply about Y?",
      "- Avoid generic fantasy/sci-fi tropes unless you're deliberately subverting them.",
      "- Ground the fantastic in the mundane: what do people eat? How do they travel? What do they argue about?",
    ];

    // Add depth-specific guidance
    if (depth <= 1) {
      basePrompt.push(
        "",
        "At this depth, focus on broad strokes: the big picture of this world or aspect.",
        "Establish the foundational premises that everything else will build on."
      );
    } else if (depth === 2) {
      basePrompt.push(
        "",
        "At this depth, develop specific aspects in detail.",
        "Connect this element to what's been established in parent nodes.",
        "Introduce tensions, contradictions, or unresolved questions that could be explored deeper."
      );
    } else {
      basePrompt.push(
        "",
        "At this depth, go granular. Specific scenes, characters, objects, rituals, conflicts.",
        "Show how the macro-level worldbuilding manifests in individual lived experience."
      );
    }

    return basePrompt.join("\n");
  },

  planPrompt(context: PlanContext): string {
    return [
      "When proposing directions for worldbuilding, consider these categories:",
      "- Geography & ecology (landforms, climate, biomes, resources)",
      "- Cultures & societies (customs, values, social structures, daily life)",
      "- History & timeline (founding events, wars, migrations, turning points)",
      "- Magic / technology (systems, rules, costs, implications)",
      "- Politics & power (governance, factions, conflicts, alliances)",
      "- Economy & trade (resources, labor, currency, trade routes)",
      "- Religion & cosmology (beliefs, practices, creation myths, afterlife)",
      "",
      "Each direction should explore a DIFFERENT category or a meaningfully different angle within the same category.",
      "Avoid generic directions like 'the culture' — be specific about WHICH aspect of culture.",
    ].join("\n");
  },

  nodeTypes: [
    {
      name: "worldbuilding",
      fields: [
        { key: "category", type: "string", description: "Worldbuilding category (geography, culture, history, magic, politics, economy, religion)" },
        { key: "region", type: "string", description: "Geographic region this applies to (if applicable)" },
        { key: "era", type: "string", description: "Historical era (if applicable)" },
        { key: "faction", type: "string", description: "Faction or group (if applicable)" },
      ],
    },
  ],

  hooks: {
    "after:generate": (context, response) => {
      // Auto-tag worldbuilding nodes with category in extension_data
      const content = (response.content || "").toLowerCase();
      let category = "general";

      if (/geography|terrain|climate|biome|mountain|river|ocean|forest|desert/i.test(content)) {
        category = "geography";
      } else if (/culture|custom|ritual|tradition|social|daily life|festival/i.test(content)) {
        category = "culture";
      } else if (/history|war|battle|founding|migration|empire|dynasty|timeline/i.test(content)) {
        category = "history";
      } else if (/magic|spell|enchant|arcane|technology|invention|power source/i.test(content)) {
        category = "magic";
      } else if (/politi|govern|king|queen|council|faction|alliance|rebellion/i.test(content)) {
        category = "politics";
      } else if (/econom|trade|merchant|currency|resource|labor|market/i.test(content)) {
        category = "economy";
      } else if (/religio|god|goddess|temple|prayer|creation myth|cosmology|afterlife/i.test(content)) {
        category = "religion";
      }

      return response;
    },
  },
};
