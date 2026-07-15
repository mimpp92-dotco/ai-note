import { installManualEditingFixture } from "../scripts/e2e-manual-editing-fixture.mjs";

export default async function globalSetup() {
  await installManualEditingFixture();
}
