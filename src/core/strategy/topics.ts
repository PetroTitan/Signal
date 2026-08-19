/**
 * Broad, explainable topic clustering (PURE).
 *
 * NOT k-means, not embeddings, not a model. The operator has to be able
 * to look at a cluster and say "yes, that is what those posts are
 * about" — and a cluster labelled by a term that actually appears in
 * every post it contains passes that test, while a centroid does not.
 *
 * THE FALSE-PRECISION GUARD
 * -------------------------
 * 37 microscopic clusters from 20 posts is worse than no clustering: it
 * looks like analysis and carries no information. So the number of
 * clusters is capped at sqrt(n) — 5 for a 28-post corpus, 3 for 12 — and
 * a term only becomes a cluster if it appears in at least 2 posts.
 *
 * Terms appearing in MOST posts are excluded too. In Signal's real
 * corpus "analytics" appears in nearly every post; a cluster containing
 * everything distinguishes nothing.
 *
 * Pure module — no I/O, no clock, no LLM.
 */

import { tokenize } from "@/core/intelligence/similarity";
import { classified, unknownClassification, type Classified } from "./evidence";

/** A term must appear in at least this many posts to anchor a cluster. */
export const MIN_DOCS_PER_CLUSTER = 2;

/**
 * Below this many posts, clustering is not attempted at all.
 *
 * The two constants below would otherwise collide silently: a cluster
 * needs at least 2 posts, and a term in more than 45% of posts is
 * excluded as ubiquitous — so at n=4 a term would have to appear in
 * "at least 2 but fewer than 1.8" posts, and no cluster could ever
 * form. Rather than return an empty model for reasons an operator
 * cannot see, say so.
 */
export const MIN_POSTS_FOR_CLUSTERING = Math.ceil(
  MIN_DOCS_PER_CLUSTER / 0.45,
);

/**
 * A term appearing in more than this share of posts is too common to
 * distinguish anything.
 *
 * Calibrated against the real corpus, not guessed. At 0.6 the term
 * "analytic" survived with 16 of 28 posts (57%) and zero co-occurring
 * terms — a "topic" containing most of the feed, which tells the
 * operator nothing. At 0.45 it is correctly reclassified as ubiquitous
 * and surfaced as a defining theme instead, which is the more useful
 * statement: it is what the account is ABOUT, not a way to group it.
 */
export const MAX_DOC_FREQUENCY = 0.45;

/** Words carrying no topical meaning. Deliberately small and English-only. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "it",
  "its", "of", "in", "on", "at", "to", "for", "with", "from", "by", "as",
  "not", "no", "yes", "you", "your", "we", "our", "i", "my", "they", "them",
  "their", "he", "she", "his", "her", "what", "when", "where", "which", "who",
  "why", "how", "can", "cannot", "will", "would", "should", "could", "may",
  "might", "must", "do", "does", "did", "have", "has", "had", "more", "most",
  "less", "least", "very", "just", "only", "also", "still", "even", "about",
  "into", "over", "after", "before", "because", "so", "such", "same", "other",
  "another", "each", "every", "any", "some", "all", "one", "two", "three",
  "first", "second", "next", "last", "new", "old", "good", "bad", "best",
  "make", "makes", "made", "get", "gets", "got", "become", "becomes", "keep",
  "keeps", "need", "needs", "want", "wants", "use", "uses", "used", "usually",
  "actually", "often", "always", "never", "here", "there", "now", "way",
  "thing", "things", "something", "nothing", "someone", "people", "work",
  "works", "working", "without", "within", "much", "many", "few", "own",
]);

export interface TopicDoc {
  id: string;
  body: string;
  title?: string | null;
  publishedAt: string;
  platform: string;
}

export interface TopicCluster {
  /** The anchoring term, used verbatim as the label. */
  key: string;
  label: string;
  postIds: string[];
  /** Terms that co-occur, for the operator to recognise the cluster. */
  relatedTerms: string[];
  postCount: number;
  firstPublishedAt: string;
  lastPublishedAt: string;
}

export interface TopicModel {
  clusters: TopicCluster[];
  /** Posts that matched no cluster. Never hidden. */
  unclustered: string[];
  /** Terms excluded for appearing in too many posts, with their share. */
  ubiquitousTerms: Array<{ term: string; share: number }>;
  totalPosts: number;
  /** The cap actually applied, so the operator can see the constraint. */
  maxClusters: number;
}

/** Content terms in a document, deduplicated. */
export function contentTerms(doc: TopicDoc): Set<string> {
  const text = `${doc.title ?? ""} ${doc.body}`;
  const terms = tokenize(text)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    // Crude singularisation so "dashboards" and "dashboard" cluster together.
    .map((t) => (t.endsWith("s") && !t.endsWith("ss") && t.length > 4 ? t.slice(0, -1) : t));
  return new Set(terms);
}

export function buildTopicModel(docs: readonly TopicDoc[]): TopicModel {
  const n = docs.length;
  const maxClusters = Math.max(1, Math.floor(Math.sqrt(n)));

  if (n < MIN_POSTS_FOR_CLUSTERING) {
    return {
      clusters: [],
      unclustered: docs.map((d) => d.id),
      ubiquitousTerms: [],
      totalPosts: n,
      maxClusters,
    };
  }

  // Document frequency per term.
  const docTerms = new Map<string, Set<string>>();
  const df = new Map<string, string[]>();
  for (const doc of docs) {
    const terms = contentTerms(doc);
    docTerms.set(doc.id, terms);
    for (const term of terms) {
      df.set(term, [...(df.get(term) ?? []), doc.id]);
    }
  }

  const ubiquitousTerms: Array<{ term: string; share: number }> = [];
  const candidates: Array<{ term: string; ids: string[] }> = [];

  for (const [term, ids] of df) {
    const share = ids.length / n;
    if (ids.length < MIN_DOCS_PER_CLUSTER) continue;
    if (share > MAX_DOC_FREQUENCY) {
      ubiquitousTerms.push({ term, share: Math.round(share * 100) / 100 });
      continue;
    }
    candidates.push({ term, ids });
  }

  // Most-covering terms first; ties alphabetical so the model is stable.
  candidates.sort((a, b) => b.ids.length - a.ids.length || a.term.localeCompare(b.term));

  const assigned = new Set<string>();
  const clusters: TopicCluster[] = [];

  for (const candidate of candidates) {
    if (clusters.length >= maxClusters) break;
    // Only take the posts not already in a cluster, so a post belongs to
    // exactly one topic and the counts add up.
    const fresh = candidate.ids.filter((id) => !assigned.has(id));
    if (fresh.length < MIN_DOCS_PER_CLUSTER) continue;

    for (const id of fresh) assigned.add(id);
    const members = docs.filter((d) => fresh.includes(d.id));
    const dates = members.map((m) => m.publishedAt).sort();

    clusters.push({
      key: candidate.term,
      label: candidate.term,
      postIds: fresh,
      relatedTerms: coOccurring(fresh, docTerms, candidate.term),
      postCount: fresh.length,
      firstPublishedAt: dates[0],
      lastPublishedAt: dates[dates.length - 1],
    });
  }

  return {
    clusters,
    unclustered: docs.filter((d) => !assigned.has(d.id)).map((d) => d.id),
    ubiquitousTerms: ubiquitousTerms
      .sort((a, b) => b.share - a.share)
      .slice(0, 10),
    totalPosts: n,
    maxClusters,
  };
}

/** Terms shared by most members of a cluster, for recognisability. */
function coOccurring(
  ids: readonly string[],
  docTerms: ReadonlyMap<string, Set<string>>,
  exclude: string,
): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    for (const term of docTerms.get(id) ?? []) {
      if (term === exclude) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= Math.max(2, Math.ceil(ids.length / 2)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([term]) => term);
}

/** Which cluster a post belongs to, with the reason. */
export function topicOf(model: TopicModel, postId: string): Classified<string> {
  const cluster = model.clusters.find((c) => c.postIds.includes(postId));
  if (!cluster) {
    return unknownClassification(
      "unclustered",
      "No term in this post recurs across enough other posts to form a topic.",
    );
  }
  return classified(cluster.key, cluster.postCount >= 4 ? "moderate" : "weak", [
    `Shares the term "${cluster.key}" with ${cluster.postCount - 1} other post(s).`,
  ]);
}

/**
 * Topics not used recently — the input to an "explore" recommendation.
 * A topic is dormant when its most recent post predates the cutoff.
 */
export function dormantTopics(
  model: TopicModel,
  nowIso: string,
  dormantAfterDays = 30,
): TopicCluster[] {
  const cutoff = new Date(
    Date.parse(nowIso) - dormantAfterDays * 86_400_000,
  ).toISOString();
  return model.clusters
    .filter((c) => c.lastPublishedAt < cutoff)
    .sort((a, b) => a.lastPublishedAt.localeCompare(b.lastPublishedAt));
}

/** Operator-readable description of the model. */
export function describeTopicModel(model: TopicModel): string {
  if (model.totalPosts === 0) return "Nothing published yet, so there are no topics.";
  if (model.totalPosts < MIN_POSTS_FOR_CLUSTERING) {
    return `${model.totalPosts} post(s) — at least ${MIN_POSTS_FOR_CLUSTERING} are needed before topics can be told apart from the account's general subject.`;
  }
  if (model.clusters.length === 0) {
    return `No topic recurs across ${MIN_DOCS_PER_CLUSTER} or more of your ${model.totalPosts} posts, so nothing groups yet.`;
  }
  const parts = model.clusters.map((c) => `${c.label} (${c.postCount})`);
  const tail =
    model.unclustered.length > 0
      ? ` ${model.unclustered.length} post(s) match no recurring topic.`
      : "";
  return `${model.clusters.length} recurring topic(s) across ${model.totalPosts} posts: ${parts.join(", ")}.${tail}`;
}
