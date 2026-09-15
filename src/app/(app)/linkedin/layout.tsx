import { Topbar } from "@/components/topbar";
import { LinkedInSubnav } from "./_subnav";
import { BoundaryNotice } from "./_boundary-notice";

/**
 * The LinkedIn Sales section. One title, one sub-navigation, and the
 * boundary notice on EVERY page — the notice is not a first-run tip.
 */
export default function LinkedInSalesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar
        title="LinkedIn Sales"
        description="Import the people your organisation already knows, plan the steps, and work through tasks yourself. Signal prepares; you act."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6">
        <LinkedInSubnav />
        <BoundaryNotice />
        {children}
      </div>
    </>
  );
}
