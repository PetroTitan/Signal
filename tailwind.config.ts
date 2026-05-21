import type { Config } from "tailwindcss";

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
        // Calm, infrastructure-grade palette
        ink: {
          50: "#f6f7f9",
          100: "#eceef2",
          200: "#d5dae2",
          300: "#b0b9c7",
          400: "#8593a5",
          500: "#647284",
          600: "#4f5b6c",
          700: "#404a58",
          800: "#363e4a",
          900: "#1f242c",
          950: "#13171c",
        },
        signal: {
          50: "#eef6ff",
          100: "#d9eaff",
          200: "#bcd9ff",
          300: "#8ec0ff",
          400: "#599cff",
          500: "#3479ff",
          600: "#1c5af0",
          700: "#1648d6",
          800: "#173dac",
          900: "#193786",
        },
        risk: {
          low: "#16a34a",
          medium: "#d97706",
          high: "#dc2626",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Inter", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
