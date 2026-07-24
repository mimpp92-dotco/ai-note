import { installFirstRunFixture } from "../scripts/e2e-first-run-fixture.mjs";
import { installManualEditingFixture } from "../scripts/e2e-manual-editing-fixture.mjs";

export default async function globalSetup() {
  await installManualEditingFixture();
  await installFirstRunFixture();
}
