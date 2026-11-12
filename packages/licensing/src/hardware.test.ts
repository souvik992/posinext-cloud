import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { HARDWARE_ID_PATTERN, formatHardwareId, hardwareId, hostedHardwareId, normaliseHardwareId } from "./index.ts";

const fixtures = JSON.parse(readFileSync(new URL("./test-fixtures/compat.json", import.meta.url), "utf8")) as {
  hardwareIdentifiers: string[]; hardwareId: string; hostedOutletId: string; hostedIdentifiers: string[]; hostedHardwareId: string;
};

test("the same identifiers give the same id as the Fine Dine app, so issued keys keep matching their PC", () => {
  assert.equal(formatHardwareId(fixtures.hardwareIdentifiers), fixtures.hardwareId);
  assert.equal(hostedHardwareId(fixtures.hostedOutletId, fixtures.hostedIdentifiers), fixtures.hostedHardwareId);
});

test("ids are read back in one form", () => {
  assert.equal(normaliseHardwareId(` ${fixtures.hardwareId.toLowerCase()} `), fixtures.hardwareId);
  assert.equal(normaliseHardwareId("AB12-CD34"), null);
  assert.equal(normaliseHardwareId(undefined), null);
});

test("this machine has a well-formed id", () => {
  assert.match(hardwareId(), HARDWARE_ID_PATTERN);
});
