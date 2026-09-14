import type { Config } from "tailwindcss";

// Tokens mirror the CivicPulse design canvas (design/Main.dc.html).
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F6F4EE",
        raised: "#FBFAF6",
        chip: "#F1EEE6",
        ink: {
          DEFAULT: "#0F1B2D",
          body: "#1F2A3C",
          soft: "#3B4658",
          muted: "#5B6474",
        },
        rule: {
          DEFAULT: "#DDD8CC",
          soft: "#E8E4DA",
          strong: "#C9C3B5",
          field: "#7D8797",
        },
        civic: "#1E48C7",
        marker: "#FFE27A",
        urgency: {
          "high-fg": "#A4161A",
          "high-bg": "#FCE8E6",
          "high-line": "#F2B8B5",
          "med-fg": "#8A4B00",
          "med-bg": "#FDF0D5",
          "med-line": "#F0CF8E",
          "low-fg": "#1B6B3A",
          "low-bg": "#E3F3E8",
          "low-line": "#A9D8B8",
        },
        night: {
          text: "#C7CFDB",
          muted: "#AEB8C7",
        },
      },
      fontFamily: {
        serif: ["var(--font-newsreader)", "Georgia", "Times New Roman", "serif"],
        sans: ["var(--font-atkinson)", "Segoe UI", "Arial", "sans-serif"],
        mono: ["var(--font-plex-mono)", "Consolas", "Courier New", "monospace"],
      },
      boxShadow: {
        card: "0 18px 36px -30px rgba(15, 27, 45, 0.45)",
        panel: "0 20px 44px -32px rgba(15, 27, 45, 0.4)",
        sheet: "0 24px 48px -32px rgba(15, 27, 45, 0.45)",
        lift: "0 28px 50px -24px rgba(15, 27, 45, 0.5)",
        modal: "0 48px 96px -40px rgba(0, 0, 0, 0.6)",
      },
      maxWidth: {
        page: "1200px",
      },
    },
  },
  plugins: [],
};

export default config;
