import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function DashboardIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function ProductsIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M12 3 21 7v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

export function AccountsIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M21.5 18a4.5 4.5 0 0 0-6-4" />
    </svg>
  );
}

export function PlanIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
    </svg>
  );
}

export function ApprovalIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M9 12l2 2 4-4" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function SchedulerIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function RiskIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M12 3 2 21h20z" />
      <path d="M12 10v5" />
      <path d="M12 18.5h0" />
    </svg>
  );
}

export function AnalyticsIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M3 21h18" />
      <path d="M6 17v-5" />
      <path d="M11 17V8" />
      <path d="M16 17v-7" />
      <path d="M21 17V5" />
    </svg>
  );
}

export function SettingsIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function DotIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.35-4.35" />
    </svg>
  );
}

export function DiscoverabilityIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
    </svg>
  );
}

export function PlatformsIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18" />
      <path d="M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

export function BacklogIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h6" />
    </svg>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <svg {...base} {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </svg>
  );
}
