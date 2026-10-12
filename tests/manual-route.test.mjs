import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { GET } from "../src/app/api/manual/route.ts";

test("manual endpoint serves the bundled PDF inline", async () => {
  const response = await GET();
  const pdf = new Uint8Array(await response.arrayBuffer());
  const expectedPdf = await readFile("public/why-box-user-manual.pdf");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="why-box-user-manual.pdf"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(pdf), expectedPdf);
});
