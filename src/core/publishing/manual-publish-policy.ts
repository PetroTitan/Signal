/**
 * Phase F2.6 — manual-publish policy.
 *
 * Re-exports the manual-publish evaluator that lives in
 * `safe-test-policy` so callers have a stable module path matching
 * the spec. The actual gate logic shares the live-publish
 * evaluator with a `skipOauthGates: true` flag — that way the
 * authoritative gate list stays in one place and can't drift.
 *
 * Manual policy gates (all of the following must pass):
 *   - SAFE_TEST_MODE=true
 *   - content_type='post' AND platform='reddit'
 *   - subreddit in ALLOWED_TEST_SUBREDDITS
 *   - operator confirmation phrase matches exactly
 *   - account review_status='confirmed'
 *   - product review_status='confirmed' (if attached)
 *   - active weekly_approval_contracts row
 *   - creative readiness (asset_url|source_url + alt text + license
 *     for external sources + status='approved')
 *   - scheduled_at <= now
 *   - rate limit (1/hour, 3/24h per workspace)
 *   - no duplicate fingerprint within 30 days
 *
 * Manual policy does NOT require:
 *   - Reddit OAuth connection
 *   - Stored access token
 *   - Reddit `submit` scope
 *   - Reddit API approval
 *
 * The operator publishes manually on Reddit and pastes the
 * permalink back; Signal records publish_history.mode='manual'.
 */

import "server-only";

export {
  evaluateManualPublishPolicy,
  type SafeTestPolicyInput as ManualPublishPolicyInput,
  type SafeTestPolicyVerdict as ManualPublishPolicyVerdict,
  type SafeTestReasonCode as ManualPublishReasonCode,
  type PublishPayloadPreview as ManualPublishPayloadPreview,
} from "./safe-test-policy";
