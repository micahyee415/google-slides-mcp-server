import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsThreshold, buildBulkAlertText } from "../audit.js";

test("exceedsThreshold: strictly greater than threshold", () => {
  assert.equal(exceedsThreshold(21, 20), true);
  assert.equal(exceedsThreshold(20, 20), false);
  assert.equal(exceedsThreshold(5, 20), false);
});

test("buildBulkAlertText: includes user, tool, count, and a deck link", () => {
  const text = buildBulkAlertText({
    userEmail: "user@example.com",
    tool: "update_table_cells",
    objectsModified: 50,
    presentationId: "p1",
    detail: "50 cell(s)",
    durationMs: 1234,
  }, 20);
  assert.match(text, /Bulk operation on google-slides-mcp/);
  assert.match(text, /user@example.com/);
  assert.match(text, /update_table_cells/);
  assert.match(text, /50/);
  assert.match(text, /presentation\/d\/p1\/edit/);
  assert.match(text, /1234ms/);
});

test("buildBulkAlertText: no presentation id → placeholder, no detail line", () => {
  const text = buildBulkAlertText({
    userEmail: "user@example.com",
    tool: "replace_all_text",
    objectsModified: 30,
    durationMs: 10,
  }, 20);
  assert.match(text, /no presentation id captured/);
  assert.doesNotMatch(text, /Detail:/);
});
