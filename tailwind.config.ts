import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      colors: {
        luma: {
          bg: "#0b0f14",
          surface: "#111821",
          panel: "#0f161f",
          border: "#1f2a37",
          muted: "#7d8796",
          text: "#e6edf3",
          accent: "#6ee7b7",
          accent2: "#38bdf8",
          warn: "#f59e0b",
          danger: "#ef4444",
        },
      },
      boxShadow: {
        soft: "0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
