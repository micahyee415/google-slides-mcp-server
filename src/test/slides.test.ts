import { test } from "node:test";
import assert from "node:assert/strict";
import type { slides_v1 } from "googleapis";
import {
  elementKind,
  elementText,
  tableText,
  tableCellText,
  findTableElement,
  extractOutline,
  slideNotesText,
  extractText,
  findSheetsChartObjectIds,
  buildReplaceAllTextRequests,
  buildUpdateTableCellRequests,
  buildInsertTableCellRequests,
  buildTableCellUpdateRequests,
  buildReplaceImageRequest,
  buildInsertImageRequest,
  buildEmbedSheetsChartRequest,
  buildRefreshChartRequests,
} from "../slides-client.js";

function table(rows: string[][]): slides_v1.Schema$Table {
  return {
    tableRows: rows.map((cols) => ({
      tableCells: cols.map((content) => ({ text: { textElements: [{ textRun: { content } }] } })),
    })),
  } as slides_v1.Schema$Table;
}

function shape(content: string): slides_v1.Schema$PageElement {
  return { shape: { text: { textElements: [{ textRun: { content } }] } } } as slides_v1.Schema$PageElement;
}

// ─── elementKind / elementText ──────────────────────────────────────────────

test("elementKind: classifies each element type", () => {
  assert.equal(elementKind({ shape: {} } as slides_v1.Schema$PageElement), "shape");
  assert.equal(elementKind({ table: {} } as slides_v1.Schema$PageElement), "table");
  assert.equal(elementKind({ image: {} } as slides_v1.Schema$PageElement), "image");
  assert.equal(elementKind({ sheetsChart: {} } as slides_v1.Schema$PageElement), "sheetsChart");
  assert.equal(elementKind({} as slides_v1.Schema$PageElement), "other");
});

test("elementText: concatenates text runs and trims", () => {
  const el = { shape: { text: { textElements: [{ textRun: { content: "Hello " } }, { textRun: { content: "world\n" } }] } } } as slides_v1.Schema$PageElement;
  assert.equal(elementText(el), "Hello world");
});

test("elementText: non-text element → empty string", () => {
  assert.equal(elementText({ image: {} } as slides_v1.Schema$PageElement), "");
});

test("elementText: table element → all cell text", () => {
  const el = { table: table([["Metric", "Value"], ["Health", "98%"]]) } as slides_v1.Schema$PageElement;
  assert.equal(elementText(el), "Metric | Value\nHealth | 98%");
});

test("tableText / tableCellText: read cell content", () => {
  const t = table([["A", "B"], ["C", "D"]]);
  assert.equal(tableText(t), "A | B\nC | D");
  assert.equal(tableCellText(t, 1, 0), "C");
  assert.equal(tableCellText(t, 9, 9), "");
  assert.equal(tableCellText(undefined, 0, 0), "");
});

// ─── extractOutline ─────────────────────────────────────────────────────────

test("extractOutline: returns slide + element object IDs, kinds, text", () => {
  const p = {
    presentationId: "p1",
    title: "Deck",
    slides: [{ objectId: "s1", pageElements: [{ objectId: "e1", ...shape("Hello") }] }],
  } as unknown as slides_v1.Schema$Presentation;
  const out = extractOutline(p);
  assert.equal(out.presentationId, "p1");
  assert.equal(out.title, "Deck");
  assert.equal(out.slideCount, 1);
  assert.deepEqual(out.slides[0], { objectId: "s1", elements: [{ objectId: "e1", kind: "shape", text: "Hello" }] });
});

test("extractOutline: empty presentation → zero slides, default title", () => {
  const out = extractOutline({} as slides_v1.Schema$Presentation);
  assert.equal(out.title, "Untitled");
  assert.equal(out.slideCount, 0);
  assert.deepEqual(out.slides, []);
});

// ─── speaker notes / text ─────────────────────────────────────────────────────

test("slideNotesText: extracts the speaker-notes shape by id", () => {
  const slide = {
    objectId: "s1",
    slideProperties: {
      notesPage: {
        notesProperties: { speakerNotesObjectId: "notes1" },
        pageElements: [{ objectId: "notes1", ...shape("Talk track here") }],
      },
    },
  } as unknown as slides_v1.Schema$Page;
  assert.equal(slideNotesText(slide), "Talk track here");
});

test("slideNotesText: no notes page → empty", () => {
  assert.equal(slideNotesText({ objectId: "s1" } as slides_v1.Schema$Page), "");
});

test("extractText: includes title, slide header, body, and notes", () => {
  const p = {
    title: "Deck",
    slides: [{
      objectId: "s1",
      pageElements: [shape("Title line")],
      slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: "n1" }, pageElements: [{ objectId: "n1", ...shape("notes!") }] } },
    }],
  } as unknown as slides_v1.Schema$Presentation;
  const text = extractText(p);
  assert.match(text, /# Deck/);
  assert.match(text, /## Slide 1 \(s1\)/);
  assert.match(text, /Title line/);
  assert.match(text, /Speaker notes:_ notes!/);
});

// ─── findSheetsChartObjectIds ─────────────────────────────────────────────────

test("findSheetsChartObjectIds: returns ids of linked charts only", () => {
  const p = {
    slides: [
      { pageElements: [{ objectId: "c1", sheetsChart: {} }, { objectId: "x", shape: {} }] },
      { pageElements: [{ objectId: "c2", sheetsChart: {} }] },
    ],
  } as unknown as slides_v1.Schema$Presentation;
  assert.deepEqual(findSheetsChartObjectIds(p), ["c1", "c2"]);
});

// ─── request builders ─────────────────────────────────────────────────────────

test("buildReplaceAllTextRequests: one matchCase request per replacement", () => {
  const reqs = buildReplaceAllTextRequests([
    { find: "{{q}}", replace: "Q2 2026" },
    { find: "{{d}}", replace: "May 26", pageObjectIds: ["s1"] },
  ]);
  assert.deepEqual(reqs[0], { replaceAllText: { containsText: { text: "{{q}}", matchCase: true }, replaceText: "Q2 2026" } });
  assert.deepEqual((reqs[1] as Record<string, unknown>).replaceAllText, { containsText: { text: "{{d}}", matchCase: true }, replaceText: "May 26", pageObjectIds: ["s1"] });
});

test("buildUpdateTableCellRequests: delete(ALL)+insert per cell", () => {
  const reqs = buildUpdateTableCellRequests("tbl1", [{ row: 0, column: 1, text: "42" }]);
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[0], { deleteText: { objectId: "tbl1", cellLocation: { rowIndex: 0, columnIndex: 1 }, textRange: { type: "ALL" } } });
  assert.deepEqual(reqs[1], { insertText: { objectId: "tbl1", cellLocation: { rowIndex: 0, columnIndex: 1 }, text: "42", insertionIndex: 0 } });
});

test("buildInsertTableCellRequests: insert-only per cell", () => {
  const reqs = buildInsertTableCellRequests("tbl1", [{ row: 2, column: 3, text: "x" }]);
  assert.deepEqual(reqs, [{ insertText: { objectId: "tbl1", cellLocation: { rowIndex: 2, columnIndex: 3 }, text: "x", insertionIndex: 0 } }]);
});

test("buildReplaceImageRequest: CENTER_CROP replace", () => {
  assert.deepEqual(buildReplaceImageRequest("img1", "https://x/logo.png"), [
    { replaceImage: { imageObjectId: "img1", url: "https://x/logo.png", imageReplaceMethod: "CENTER_CROP" } },
  ]);
});

test("buildInsertImageRequest: createImage with sized element properties", () => {
  const reqs = buildInsertImageRequest("s1", "https://x/p.png", { widthPt: 300, heightPt: 200, xPt: 50, yPt: 60 });
  const ci = (reqs[0] as Record<string, any>).createImage;
  assert.equal(ci.url, "https://x/p.png");
  assert.equal(ci.elementProperties.pageObjectId, "s1");
  assert.equal(ci.elementProperties.size.width.magnitude, 300);
  assert.equal(ci.elementProperties.transform.translateY, 60);
});

test("buildEmbedSheetsChartRequest: LINKED chart with spreadsheet + chart id", () => {
  const reqs = buildEmbedSheetsChartRequest("s1", "sh1", 123, { widthPt: 400, heightPt: 300, xPt: 50, yPt: 50 });
  const c = (reqs[0] as Record<string, any>).createSheetsChart;
  assert.equal(c.spreadsheetId, "sh1");
  assert.equal(c.chartId, 123);
  assert.equal(c.linkingMode, "LINKED");
  assert.equal(c.elementProperties.pageObjectId, "s1");
});

test("buildRefreshChartRequests: one refresh per object id", () => {
  assert.deepEqual(buildRefreshChartRequests(["c1", "c2"]), [
    { refreshSheetsChart: { objectId: "c1" } },
    { refreshSheetsChart: { objectId: "c2" } },
  ]);
});

test("findTableElement: locates a table by objectId across slides", () => {
  const p = {
    slides: [
      { pageElements: [{ objectId: "shape1", shape: {} }] },
      { pageElements: [{ objectId: "tbl1", table: table([["x"]]) }] },
    ],
  } as unknown as slides_v1.Schema$Presentation;
  assert.ok(findTableElement(p, "tbl1"));
  assert.equal(findTableElement(p, "nope"), undefined);
});

test("buildTableCellUpdateRequests: delete+insert for filled cells, insert-only for empty", () => {
  // Cell (0,0) has "old"; cell (0,1) is empty.
  const t = table([["old", ""]]);
  const reqs = buildTableCellUpdateRequests("tbl1", t, [
    { row: 0, column: 0, text: "new" },
    { row: 0, column: 1, text: "fresh" },
  ]);
  // Filled cell → 2 requests (delete + insert); empty cell → 1 request (insert only).
  assert.equal(reqs.length, 3);
  assert.ok((reqs[0] as Record<string, unknown>).deleteText, "filled cell deletes first");
  assert.ok((reqs[1] as Record<string, unknown>).insertText);
  assert.ok((reqs[2] as Record<string, unknown>).insertText, "empty cell is insert-only");
  assert.equal((reqs[2] as Record<string, any>).insertText.cellLocation.columnIndex, 1);
});

test("buildTableCellUpdateRequests: undefined table → all insert-only", () => {
  const reqs = buildTableCellUpdateRequests("tbl1", undefined, [{ row: 0, column: 0, text: "x" }]);
  assert.equal(reqs.length, 1);
  assert.ok((reqs[0] as Record<string, unknown>).insertText);
});
