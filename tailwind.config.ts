import type { Config } from "tailwindcss";

/**
 * Signal Tailwind theme — Phase 1.
 *
 * Color tokens read from CSS variables defined in `src/app/globals.css`
 * so the same class names (`bg-signal-500`, `text-ink-700`, etc.) stay
 * stable while their resolved values move to the new brand palette.
 *
 * The RGB triplet + `<alpha-value>` pattern lets Tailwind continue to
 * support `bg-signal-500/10`, `text-ink-900/60`, and friends.
 *
 * Native Tailwind palettes (emerald/amber/red/blue/sky/violet) are
 * intentionally left untouched — they're used for semantic states and
 * platform-brand chips that should NOT take on the Signal brand color.
 */

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/features/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "rgb(var(--ink-50) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          950: "rgb(var(--ink-950) / <alpha-value>)",
        },
        signal: {
          50: "rgb(var(--signal-50) / <alpha-value>)",
          100: "rgb(var(--signal-100) / <alpha-value>)",
          200: "rgb(var(--signal-200) / <alpha-value>)",
          300: "rgb(var(--signal-300) / <alpha-value>)",
          400: "rgb(var(--signal-400) / <alpha-value>)",
          500: "rgb(var(--signal-500) / <alpha-value>)",
          600: "rgb(var(--signal-600) / <alpha-value>)",
          700: "rgb(var(--signal-700) / <alpha-value>)",
          800: "rgb(var(--signal-800) / <alpha-value>)",
          900: "rgb(var(--signal-900) / <alpha-value>)",
        },
        accent: {
          50: "rgb(var(--accent-50) / <alpha-value>)",
          100: "rgb(var(--accent-100) / <alpha-value>)",
          200: "rgb(var(--accent-200) / <alpha-value>)",
          300: "rgb(var(--accent-300) / <alpha-value>)",
          400: "rgb(var(--accent-400) / <alpha-value>)",
          500: "rgb(var(--accent-500) / <alpha-value>)",
          600: "rgb(var(--accent-600) / <alpha-value>)",
          700: "rgb(var(--accent-700) / <alpha-value>)",
          800: "rgb(var(--accent-800) / <alpha-value>)",
          900: "rgb(var(--accent-900) / <alpha-value>)",
        },
        risk: {
          low: "#16a34a",
          medium: "#d97706",
          high: "#dc2626",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Inter",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      borderRadius: {
        xs: "4px",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        card: "var(--shadow-sm)",
        focus: "var(--shadow-focus)",
        "focus-success": "var(--shadow-focus-success)",
      },
    },
  },
  plugins: [],
};

export default config;
