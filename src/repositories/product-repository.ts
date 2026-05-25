import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  ProductInsert,
  ProductRow,
  ProductUpdate,
} from "@/lib/supabase/types";
import { fromPostgres, notAuthenticated, notFound } from "./errors";

export interface Product {
  id: string;
  workspaceId: string;
  name: string;
  domain: string | null;
  summary: string | null;
  category: string | null;
  status: string;
  source: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    domain: row.domain,
    summary: row.summary,
    category: row.category,
    status: row.status,
    source: row.source,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List active (non-archived) products for the workspace. Pass
 * `includeArchived: true` to get everything.
 */
export async function listProducts(
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Product[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from("products")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (!options.includeArchived) {
    query = query.neq("status", "archived");
  }
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list products.");
  return ((data ?? []) as unknown as ProductRow[]).map(toProduct);
}

export async function archiveProduct(input: {
  workspaceId: string;
  productId: string;
}): Promise<Product> {
  return updateProduct({
    workspaceId: input.workspaceId,
    productId: input.productId,
    status: "archived",
  });
}

export async function getProductById(
  workspaceId: string,
  productId: string,
  /** Optional injected client; see getAccountById's doc note. */
  db?: SupabaseClient,
): Promise<Product> {
  const supabase = db ?? createSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load product.");
  if (!data) throw notFound("Product");
  return toProduct(data as unknown as ProductRow);
}

export interface ProductInput {
  workspaceId: string;
  name: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw notAuthenticated();

  const insert: ProductInsert = {
    workspace_id: input.workspaceId,
    name: input.name,
    domain: input.domain ?? null,
    summary: input.summary ?? null,
    category: input.category ?? null,
  };
  const { data, error } = await supabase
    .from("products")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create product.");
  return toProduct(data as unknown as ProductRow);
}

export async function updateProduct(input: {
  workspaceId: string;
  productId: string;
  name?: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
  status?: string;
  reviewStatus?: "pending_review" | "confirmed" | "rejected" | "needs_edit";
}): Promise<Product> {
  const supabase = createSupabaseServerClient();
  const patch: ProductUpdate = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.domain !== undefined) patch.domain = input.domain;
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.category !== undefined) patch.category = input.category;
  if (input.status !== undefined) patch.status = input.status;
  if (input.reviewStatus !== undefined) patch.review_status = input.reviewStatus;
  const { data, error } = await supabase
    .from("products")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.productId)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to update product.");
  return toProduct(data as unknown as ProductRow);
}

/**
 * Products waiting for operator review (the approval-queue feed).
 * Excludes archived rows; sorted oldest-first so the operator burns
 * down the queue in order of submission.
 */
export async function listProductsPendingReview(
  workspaceId: string,
): Promise<Product[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("review_status", "pending_review")
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) throw fromPostgres(error, "Failed to list products pending review.");
  return ((data ?? []) as unknown as ProductRow[]).map(toProduct);
}

export async function approveProductReview(input: {
  workspaceId: string;
  productId: string;
}): Promise<Product> {
  return updateProduct({
    workspaceId: input.workspaceId,
    productId: input.productId,
    reviewStatus: "confirmed",
  });
}

export async function rejectProductReview(input: {
  workspaceId: string;
  productId: string;
}): Promise<Product> {
  return updateProduct({
    workspaceId: input.workspaceId,
    productId: input.productId,
    reviewStatus: "rejected",
  });
}
