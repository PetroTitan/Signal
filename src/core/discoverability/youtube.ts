import type {
  ProductProfile,
  YouTubeCadencePlan,
  YouTubeIdea,
} from "@/types";

export function buildYouTubeIdeas(product: ProductProfile): YouTubeIdea[] {
  const audience = product.targetAudience[0] ?? "operators";
  return [
    {
      id: `yt_${product.id}_shorts_1`,
      productId: product.id,
      kind: "shorts",
      title: `90-second walkthrough: the one ${product.category} task ${audience} keep getting wrong`,
      description:
        "Open with the wrong way, cut to the right way. No music, no zooms.",
    },
    {
      id: `yt_${product.id}_shorts_2`,
      productId: product.id,
      kind: "shorts",
      title: `Before / after view of using ${product.name}`,
      description:
        "Single screen recording. Clear caption. Under 60 seconds.",
    },
    {
      id: `yt_${product.id}_founder_1`,
      productId: product.id,
      kind: "founder_video",
      title: `Why ${product.name} exists, in three minutes`,
      description:
        "Founder on camera. Concrete examples. Avoid the explainer-video aesthetic.",
    },
    {
      id: `yt_${product.id}_community_1`,
      productId: product.id,
      kind: "community_update",
      title: `What we shipped this month for ${product.name}`,
      description: "Short, calm, recorded once a month. Numbers preferred.",
    },
    {
      id: `yt_${product.id}_longform_1`,
      productId: product.id,
      kind: "long_form",
      title: `An honest hour with the ${product.name} workflow`,
      description:
        "Long-form video for the audience that wants to evaluate without a call.",
    },
  ];
}

export function buildYouTubeCadencePlan(
  product: ProductProfile,
): YouTubeCadencePlan {
  return {
    productId: product.id,
    weeklyTarget: 1,
    formats: ["shorts", "founder_video"],
    notes:
      "Planning only. No publishing wired. One short per week is enough for trust-building, with one founder video per month.",
  };
}
