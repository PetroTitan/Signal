import { Topbar } from "@/components/topbar";
import { AcceptInvite } from "./_accept";

export const dynamic = "force-dynamic";

/**
 * C1.1 — invitation acceptance. Lives in the (app) group, so the
 * visitor must be signed in (middleware redirects to /login otherwise).
 * A brand-new invitee signs up first, then re-opens this link (the
 * token is in the URL they were given). The SECURITY DEFINER RPC
 * verifies status/expiry/email server-side, so this page can stay a
 * thin shell — it never reads the invitation row directly.
 */
export default function AcceptInvitePage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const raw = searchParams?.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  return (
    <>
      <Topbar title="Join workspace" description="Accept your invitation." />
      <div className="px-6 lg:px-10 py-12 max-w-xl">
        <div className="card p-6">
          <AcceptInvite token={token} />
        </div>
      </div>
    </>
  );
}
