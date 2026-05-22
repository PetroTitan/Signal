export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_configured"
      | "not_authenticated"
      | "not_found"
      | "constraint"
      | "unknown",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export function notAuthenticated(): RepositoryError {
  return new RepositoryError("Not authenticated.", "not_authenticated");
}

export function notFound(what: string): RepositoryError {
  return new RepositoryError(`${what} not found.`, "not_found");
}

export function fromPostgres(error: unknown, fallback: string): RepositoryError {
  const code = isPostgresConstraintCode(error) ? "constraint" : "unknown";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : fallback;
  return new RepositoryError(message, code, error);
}

function isPostgresConstraintCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === "23505" || code === "23503" || code === "23514";
}
