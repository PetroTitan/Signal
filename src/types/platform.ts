export type PlatformId = "reddit" | "x" | "linkedin";

export interface Platform {
  id: PlatformId;
  name: string;
  shortName: string;
  description: string;
  oauthAvailable: boolean;
  cadenceGuidance: {
    minHoursBetweenPosts: number;
    maxPostsPerWeek: number;
    suggestedPostsPerWeek: number;
  };
  promotionalToneAllowance: "very_low" | "low" | "medium";
  notes: string[];
}
