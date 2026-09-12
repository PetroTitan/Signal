import type { Metadata } from "next";

/**
 * The social preview image, shared by every page that declares its own
 * `openGraph` block.
 *
 * Next's file convention injects `opengraph-image.png` automatically —
 * but ONLY for segments that do not declare `openGraph` themselves. A
 * page that sets a custom title and description therefore silently
 * loses the image, which is how the marketing homepage ended up
 * advertising `summary_large_image` with nothing to show. Spreading
 * this into each such block keeps them in step.
 */
export const OG_IMAGE: NonNullable<
  NonNullable<Metadata["openGraph"]>["images"]
> = [
  {
    url: "/opengraph-image.png",
    width: 1200,
    height: 630,
    alt: "Signal — sustainable growth operations",
  },
];
