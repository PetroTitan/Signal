"use server";

import { revalidatePath } from "next/cache";
import {
  archiveAccount,
  createAccount,
  getAccountById,
  updateAccount,
} from "@/repositories/account-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type CreateAccountResult = ActionResult<{ accountId: string }>;
export type ArchiveAccountResult = ActionResult<{ accountId: string }>;
export type UpdateVoiceProfileResult = ActionResult<{ accountId: string }>;
export type UpdateIdentitySourcesResult = ActionResult<{ accountId: string }>;

const VOICE_PROFILE_MAX = 1500;

export async function createAccountAction(
  _prevState: CreateAccountResult,
  formData: FormData,
): Promise<CreateAccountResult> {
  const platform = String(formData.get("platform") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const handle = String(formData.get("handle") ?? "").trim();
  const voiceProfile = String(formData.get("voice_profile") ?? "").trim();
  const productId = String(formData.get("product_id") ?? "").trim();
  const sourceWebsiteUrlRaw = String(
    formData.get("source_website_url") ?? "",
  ).trim();
  const referenceUrlsRaw = String(formData.get("reference_urls") ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const {
    validateIdentityReferenceUrls,
    validateIdentitySourceUrl,
  } = await import("@/core/identity-sources/url-validation");
  // Source website is required at creation for active publishing
  // identities. Operators can still leave it empty at create time
  // (it then surfaces as an explicit "this identity has no factual
  // source" warning in the UI and in the generation prompt); the
  // validator only refuses if a value is supplied that doesn't pass.
  let sourceWebsiteUrl: string | null = null;
  if (sourceWebsiteUrlRaw.length > 0) {
    const v = validateIdentitySourceUrl(sourceWebsiteUrlRaw);
    if (!v.ok) {
      return actionFail(v.message ?? "Source website URL is invalid.");
    }
    sourceWebsiteUrl = v.normalized;
  }
  let referenceUrls: string[] = [];
  if (referenceUrlsRaw.length > 0) {
    const v = validateIdentityReferenceUrls(referenceUrlsRaw);
    if (!v.ok) {
      const first = v.errors[0];
      return actionFail(
        `Reference URL #${first.index + 1} is invalid: ${first.message}`,
      );
    }
    referenceUrls = v.normalized;
  }

  if (!platform) return actionFail("Pick a platform.");
  if (!displayName)
    return actionFail("Give this publishing identity a name.");
  // F4.4 + F5.0 + F5.1 — only allow platforms with real publishing
  // or distribution paths.
  const allowed = new Set([
    "reddit",
    "devto",
    "hashnode",
    "bluesky",
    "indie_hackers",
    "x",
    "linkedin",
    "youtube",
    "threads",
    "instagram",
    "telegram",
  ]);
  if (!allowed.has(platform)) {
    return actionFail("That platform isn't supported yet.");
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return actionFail("No workspace found. Try refreshing the page.");
    }

    // Validate the product_id (if provided) belongs to this workspace.
    // Listing is cheap and avoids relying on a constraint violation to
    // surface a clearer message.
    let resolvedProductId: string | null = null;
    if (productId) {
      const products = await listProducts(membership.workspace.id);
      const match = products.find((p) => p.id === productId);
      if (!match) {
        return actionFail("Pick a product that belongs to this workspace.");
      }
      resolvedProductId = match.id;
    }

    const account = await createAccount({
      workspaceId: membership.workspace.id,
      platform,
      displayName,
      handle: handle || null,
      voiceProfile: voiceProfile || null,
      productId: resolvedProductId,
      sourceWebsiteUrl,
      referenceUrls,
    });

    try {
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "account.created",
        entityType: "account",
        entityId: account.id,
        title: `Publishing identity "${account.displayName ?? account.platform}" added`,
        description: `Platform: ${account.platform}.`,
        metadata: { platform: account.platform },
      });
    } catch (err) {
      console.error("[createAccountAction] activity log failed", err);
    }

    revalidatePath("/accounts");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
    return actionOk({ accountId: account.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not create account.";
    console.error("[createAccountAction] failed", error);
    return actionFail(message);
  }
}

export async function archiveAccountAction(
  _prev: ArchiveAccountResult,
  formData: FormData,
): Promise<ArchiveAccountResult> {
  const accountId = String(formData.get("account_id") ?? "").trim();
  if (!accountId) return actionFail("Account id is required.");

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    let displayName = "Account";
    let platform = "";
    try {
      const existing = await getAccountById(membership.workspace.id, accountId);
      displayName = existing.displayName ?? existing.handle ?? "Account";
      platform = existing.platform;
    } catch {
      // Non-fatal — still try the archive.
    }

    const archived = await archiveAccount({
      workspaceId: membership.workspace.id,
      accountId,
    });

    try {
      await recordActivity({
        workspaceId: membership.workspace.id,
        eventType: "account.archived",
        entityType: "account",
        entityId: archived.id,
        title: `Account "${displayName}" archived`,
        description: platform ? `Platform: ${platform}.` : null,
      });
    } catch (err) {
      console.error("[archiveAccountAction] activity log failed", err);
    }

    revalidatePath("/accounts");
    revalidatePath("/dashboard");
    revalidatePath("/activity");
    revalidatePath("/platforms");
    if (platform) revalidatePath(`/platforms/${platform}`);
    return actionOk({ accountId: archived.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not archive account.";
    console.error("[archiveAccountAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// F4.4 — update the voice profile (writing style) on an identity.
// =====================================================================
export async function updateVoiceProfileAction(
  _prev: UpdateVoiceProfileResult,
  formData: FormData,
): Promise<UpdateVoiceProfileResult> {
  const accountId = String(formData.get("account_id") ?? "").trim();
  const raw = String(formData.get("voice_profile") ?? "");
  const voiceProfile = raw.trim();

  if (!accountId) return actionFail("Missing identity.");
  if (voiceProfile.length > VOICE_PROFILE_MAX) {
    return actionFail(
      `Keep the voice profile under ${VOICE_PROFILE_MAX} characters.`,
    );
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const updated = await updateAccount({
      workspaceId: membership.workspace.id,
      accountId,
      voiceProfile: voiceProfile.length > 0 ? voiceProfile : null,
    });

    revalidatePath("/accounts");
    return actionOk({ accountId: updated.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not save the voice profile.";
    console.error("[updateVoiceProfileAction] failed", error);
    return actionFail(message);
  }
}

// =====================================================================
// Phase F7.0 — update the identity's canonical factual source(s).
// =====================================================================
//
// Updates source_website_url and reference_urls on the identity row.
// Validation is delegated to the pure helpers in
// `@/core/identity-sources/url-validation`. Both fields are optional:
//   - empty `source_website_url` → null (legacy mode for this row)
//   - empty `reference_urls` (one URL per line in the textarea) → []
export async function updateIdentitySourcesAction(
  _prev: UpdateIdentitySourcesResult,
  formData: FormData,
): Promise<UpdateIdentitySourcesResult> {
  const accountId = String(formData.get("account_id") ?? "").trim();
  if (!accountId) return actionFail("Missing identity.");

  const sourceWebsiteUrlRaw = String(
    formData.get("source_website_url") ?? "",
  ).trim();
  const referenceUrlsRaw = String(formData.get("reference_urls") ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const {
    validateIdentityReferenceUrls,
    validateIdentitySourceUrl,
  } = await import("@/core/identity-sources/url-validation");

  let sourceWebsiteUrl: string | null = null;
  if (sourceWebsiteUrlRaw.length > 0) {
    const v = validateIdentitySourceUrl(sourceWebsiteUrlRaw);
    if (!v.ok) {
      return actionFail(v.message ?? "Source website URL is invalid.");
    }
    sourceWebsiteUrl = v.normalized;
  }
  let referenceUrls: string[] = [];
  if (referenceUrlsRaw.length > 0) {
    const v = validateIdentityReferenceUrls(referenceUrlsRaw);
    if (!v.ok) {
      const first = v.errors[0];
      return actionFail(
        `Reference URL #${first.index + 1} is invalid: ${first.message}`,
      );
    }
    referenceUrls = v.normalized;
  }

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const updated = await updateAccount({
      workspaceId: membership.workspace.id,
      accountId,
      sourceWebsiteUrl,
      referenceUrls,
    });

    revalidatePath("/accounts");
    return actionOk({ accountId: updated.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not save identity sources.";
    console.error("[updateIdentitySourcesAction] failed", error);
    return actionFail(message);
  }
}
