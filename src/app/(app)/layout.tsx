import { SignalShell } from "@/components/signal-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SignalShell>{children}</SignalShell>;
}
