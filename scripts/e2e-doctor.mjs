import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import { chromium } from "@playwright/test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = packageJson.devDependencies?.["@playwright/test"];
const installedPackage = JSON.parse(
  await readFile(new URL("../node_modules/@playwright/test/package.json", import.meta.url), "utf8"),
);
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  throw new Error(`Playwright E2E requires the project baseline Node 20 or newer; found ${process.version}`);
}
if (expectedVersion !== installedPackage.version) {
  throw new Error(
    `@playwright/test version mismatch: package.json=${expectedVersion}, installed=${installedPackage.version}`,
  );
}

const executable = chromium.executablePath();
try {
  await access(executable, constants.X_OK);
} catch {
  throw new Error("Playwright Chromium is missing; run `npm run test:e2e:install`");
}

console.log(`Playwright doctor OK: node=${process.versions.node} playwright=${installedPackage.version} chromium=ready`);
