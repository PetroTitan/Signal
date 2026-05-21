export type ApprovalAction =
  | "approve"
  | "reject"
  | "edit"
  | "rewrite_softer"
  | "remove_link"
  | "delay"
  | "convert_to_comment"
  | "save_to_backlog";

export interface ApprovalEvent {
  id: string;
  planItemId: string;
  action: ApprovalAction;
  actorEmail: string;
  occurredAt: string;
  note?: string;
}
