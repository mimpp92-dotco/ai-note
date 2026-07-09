import tseslint from "typescript-eslint";

// Flat config. `npm run lint` runs `eslint .` (never `next lint`) so it is
// version-independent and never prompts. TS rules are scoped to .ts/.tsx.
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".claude/**",
      "out/**",
      "dist/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
  },
);
