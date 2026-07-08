import type { Config } from "tailwindcss";

// Warm beige/brown palette from docs/UI_GUIDE.md — "tool-like", low chroma.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#FAF8F4", // page
        panel: "#FFFFFF", // card/panel
        soft: "#F0EBE3", // line-soft surface
        chrome: "#F4EFE8", // toolbar chrome
        ink: "#2A2420", // primary text
        inkSoft: "#6B6158", // body/secondary text
        inkFaint: "#9A8F84", // disabled (never on small text)
        accent: "#5B4A42", // brown accent
        line: "#E8E1D7", // borders
        success: "#3F7A55",
        successBg: "#E4F0E7",
        warn: "#B4791F",
        warnBg: "#FBF0DA",
        error: "#C0392B",
      },
      fontFamily: {
        sans: ["var(--font-pretendard)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};

export default config;
