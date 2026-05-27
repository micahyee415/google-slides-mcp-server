/**
 * Google Slides + Drive API client.
 *
 * Authenticates using the user's own Google OAuth access token, passed through
 * from the Authorization header on each MCP request. Every API call runs with
 * the requesting user's own Drive and Slides permissions — Google enforces their
 * existing sharing settings on every operation.
 *
 * Access model (permission preservation — sensitive board/QBR decks):
 *   - Users can read/edit any presentation they personally have access to in Drive
 *   - Private decks are inaccessible unless the user already has Google permission —
 *     Google returns 403 automatically (surfaced via handleGoogleError)
 *   - No service account, no shared credential
 *   - NO sharing / permission-mutation method exists here — the client is
 *     structurally incapable of widening who can access a deck
 *   - duplicatePresentation copies with default (private) permissions and never
 *     touches the Drive Permissions API, so duplicating a template cannot leak it
 *
 * All methods throw SlidesApiError on API failure.
 */

import { google } from "googleapis";
import type { slides_v1, drive_v3 } from "googleapis";

// ─── Error class ──────────────────────────────────────────────────────────────

export class SlidesApiError extends Error {
  public status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "SlidesApiError";
    this.status = status;
  }
}

/**
 * Converts a Google API error into a typed SlidesApiError.
 * Returns never — always throws. 403/404 get user-friendly messages so the
 * permission boundary is communicated clearly rather than leaking raw API text.
 */
function handleGoogleError(err: unknown): never {
  if (err && typeof err === "object") {
    const e = err as { status?: number; code?: number; message?: string; errors?: Array<{ message: string }> };
    const status = e.status ?? e.code ?? 500;
    const message = e.errors?.[0]?.message ?? e.message ?? "Google API error";

    if (status === 403) {
      throw new SlidesApiError(
        "Permission denied. You do not have access to this presentation. " +
        "Check that the deck is shared with your Google account.",
        403,
      );
    }
    if (status === 404) {
      throw new SlidesApiError("Presentation or resource not found.", 404);
    }
    throw new SlidesApiError(message, status);
  }
  throw new SlidesApiError(String(err));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ElementKind = "shape" | "table" | "image" | "sheetsChart" | "line" | "video" | "other";

export interface SlideElement {
  objectId: string;
  kind: ElementKind;
  /** Concatenated text for shapes; empty string for non-text elements. */
  text: string;
}

export interface SlideOutline {
  objectId: string;
  elements: SlideElement[];
}

export interface PresentationOutline {
  presentationId: string;
  title: string;
  slideCount: number;
  slides: SlideOutline[];
}

export interface TableCellEdit {
  row: number;
  column: number;
  text: string;
}

export interface Replacement {
  find: string;
  replace: string;
  pageObjectIds?: string[];
}

export interface ElementBox {
  widthPt: number;
  heightPt: number;
  xPt: number;
  yPt: number;
}

export interface CopiedFile {
  presentationId: string;
  name: string;
  url: string;
}

// ─── Pure helpers (exported for unit testing — no API calls) ────────────────────

/** Classify a page element by which content field is present. */
export function elementKind(el: slides_v1.Schema$PageElement): ElementKind {
  if (el.shape) return "shape";
  if (el.table) return "table";
  if (el.image) return "image";
  if (el.sheetsChart) return "sheetsChart";
  if (el.line) return "line";
  if (el.video) return "video";
  return "other";
}

/** Concatenate the text runs of a Slides text body. */
function runsText(text: slides_v1.Schema$TextContent | undefined): string {
  return (text?.textElements ?? []).map((t) => t.textRun?.content ?? "").join("");
}

/** Concatenate all cells of a table, row by row, as "a | b\nc | d". */
export function tableText(table: slides_v1.Schema$Table | undefined): string {
  const rows = table?.tableRows ?? [];
  return rows
    .map((r) => (r.tableCells ?? []).map((c) => runsText(c.text).trim()).join(" | "))
    .join("\n")
    .trim();
}

/** Raw text of a single table cell (un-trimmed), or "" if absent. */
export function tableCellText(table: slides_v1.Schema$Table | undefined, row: number, column: number): string {
  return runsText(table?.tableRows?.[row]?.tableCells?.[column]?.text);
}

/** Text content of a page element — shape text or, for tables, all cell text. */
export function elementText(el: slides_v1.Schema$PageElement): string {
  if (el.shape?.text) return runsText(el.shape.text).trim();
  if (el.table) return tableText(el.table);
  return "";
}

/** Find a table element anywhere in the deck by its objectId. */
export function findTableElement(p: slides_v1.Schema$Presentation, objectId: string): slides_v1.Schema$Table | undefined {
  for (const slide of p.slides ?? []) {
    for (const el of slide.pageElements ?? []) {
      if (el.objectId === objectId && el.table) return el.table;
    }
  }
  return undefined;
}

/** Build a slimmed outline of a presentation: slide IDs + element IDs/kinds/text. */
export function extractOutline(p: slides_v1.Schema$Presentation): PresentationOutline {
  return {
    presentationId: p.presentationId ?? "",
    title: p.title ?? "Untitled",
    slideCount: p.slides?.length ?? 0,
    slides: (p.slides ?? []).map((s) => ({
      objectId: s.objectId ?? "",
      elements: (s.pageElements ?? []).map((el) => ({
        objectId: el.objectId ?? "",
        kind: elementKind(el),
        text: elementText(el),
      })),
    })),
  };
}

/** Extract the speaker-notes text for a single slide, or "" if none. */
export function slideNotesText(slide: slides_v1.Schema$Page): string {
  const notesPage = slide.slideProperties?.notesPage;
  if (!notesPage) return "";
  const notesId = notesPage.notesProperties?.speakerNotesObjectId;
  if (!notesId) return "";
  const el = (notesPage.pageElements ?? []).find((e) => e.objectId === notesId);
  if (!el) return "";
  return elementText(el);
}

/** Render a presentation as markdown text: title, per-slide body text, and speaker notes. */
export function extractText(p: slides_v1.Schema$Presentation): string {
  const parts: string[] = [`# ${p.title ?? "Untitled"}`];
  (p.slides ?? []).forEach((s, i) => {
    const body = (s.pageElements ?? [])
      .map((el) => elementText(el))
      .filter((t) => t.length > 0)
      .join("\n");
    const notes = slideNotesText(s);
    let section = `\n## Slide ${i + 1} (${s.objectId ?? ""})\n${body}`;
    if (notes) section += `\n\n_Speaker notes:_ ${notes}`;
    parts.push(section);
  });
  return parts.join("\n");
}

/** Object IDs of every linked Sheets chart in the deck. */
export function findSheetsChartObjectIds(p: slides_v1.Schema$Presentation): string[] {
  return (p.slides ?? []).flatMap((s) =>
    (s.pageElements ?? [])
      .filter((e) => e.sheetsChart)
      .map((e) => e.objectId ?? "")
      .filter((id) => id.length > 0),
  );
}

/** One replaceAllText request per replacement (matchCase true; optional slide scoping). */
export function buildReplaceAllTextRequests(items: Replacement[]): slides_v1.Schema$Request[] {
  return items.map(({ find, replace, pageObjectIds }) => ({
    replaceAllText: {
      containsText: { text: find, matchCase: true },
      replaceText: replace,
      ...(pageObjectIds && pageObjectIds.length ? { pageObjectIds } : {}),
    },
  }));
}

/** deleteText(ALL) + insertText per cell. */
export function buildUpdateTableCellRequests(tableObjectId: string, cells: TableCellEdit[]): slides_v1.Schema$Request[] {
  return cells.flatMap(({ row, column, text }) => [
    { deleteText: { objectId: tableObjectId, cellLocation: { rowIndex: row, columnIndex: column }, textRange: { type: "ALL" } } },
    { insertText: { objectId: tableObjectId, cellLocation: { rowIndex: row, columnIndex: column }, text, insertionIndex: 0 } },
  ]);
}

/** insertText-only variant — used to retry cells that were already empty. */
export function buildInsertTableCellRequests(tableObjectId: string, cells: TableCellEdit[]): slides_v1.Schema$Request[] {
  return cells.map(({ row, column, text }) => ({
    insertText: { objectId: tableObjectId, cellLocation: { rowIndex: row, columnIndex: column }, text, insertionIndex: 0 },
  }));
}

export function buildReplaceImageRequest(imageObjectId: string, url: string): slides_v1.Schema$Request[] {
  return [{ replaceImage: { imageObjectId, url, imageReplaceMethod: "CENTER_CROP" } }];
}

export function buildInsertImageRequest(slideObjectId: string, url: string, box: ElementBox): slides_v1.Schema$Request[] {
  return [{
    createImage: {
      url,
      elementProperties: {
        pageObjectId: slideObjectId,
        size: { width: { magnitude: box.widthPt, unit: "PT" }, height: { magnitude: box.heightPt, unit: "PT" } },
        transform: { scaleX: 1, scaleY: 1, translateX: box.xPt, translateY: box.yPt, unit: "PT" },
      },
    },
  }];
}

export function buildEmbedSheetsChartRequest(
  slideObjectId: string, spreadsheetId: string, chartId: number, box: ElementBox,
): slides_v1.Schema$Request[] {
  return [{
    createSheetsChart: {
      spreadsheetId,
      chartId,
      linkingMode: "LINKED",
      elementProperties: {
        pageObjectId: slideObjectId,
        size: { width: { magnitude: box.widthPt, unit: "PT" }, height: { magnitude: box.heightPt, unit: "PT" } },
        transform: { scaleX: 1, scaleY: 1, translateX: box.xPt, translateY: box.yPt, unit: "PT" },
      },
    },
  }];
}

export function buildRefreshChartRequests(chartObjectIds: string[]): slides_v1.Schema$Request[] {
  return chartObjectIds.map((objectId) => ({ refreshSheetsChart: { objectId } }));
}

/**
 * Build per-cell update requests, choosing delete+insert for cells that already
 * have text and insert-only for empty cells. This avoids both (a) deleteText
 * failing on an empty cell and (b) prepending text to a non-empty cell — the two
 * failure modes of a blind all-or-nothing batch. `table` is the live table (from
 * findTableElement) used only to read current cell content; pass undefined to
 * treat every cell as empty (insert-only).
 */
export function buildTableCellUpdateRequests(
  tableObjectId: string, table: slides_v1.Schema$Table | undefined, cells: TableCellEdit[],
): slides_v1.Schema$Request[] {
  return cells.flatMap((c) =>
    tableCellText(table, c.row, c.column).trim().length > 0
      ? buildUpdateTableCellRequests(tableObjectId, [c])
      : buildInsertTableCellRequests(tableObjectId, [c]),
  );
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class SlidesClient {
  private readonly slides: slides_v1.Slides;
  private readonly drive: drive_v3.Drive;

  constructor(accessToken: string) {
    // Per-user OAuth — API calls run as the requesting user.
    // Google enforces their existing Drive/Slides permissions on every call.
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.slides = google.slides({ version: "v1", auth, timeout: 30_000 });
    this.drive = google.drive({ version: "v3", auth, timeout: 30_000 });
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /** Fetch the full presentation resource. */
  async getPresentation(presentationId: string): Promise<slides_v1.Schema$Presentation> {
    try {
      const res = await this.slides.presentations.get({ presentationId });
      return res.data;
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Outline (slide IDs, element IDs/kinds/text) for targeting edits. */
  async getOutline(presentationId: string): Promise<PresentationOutline> {
    const p = await this.getPresentation(presentationId);
    return extractOutline(p);
  }

  /** Full text + speaker notes rendered as markdown. */
  async getText(presentationId: string): Promise<string> {
    const p = await this.getPresentation(presentationId);
    return extractText(p);
  }

  /** Render a slide as a PNG thumbnail; returns Google's temporary content URL. */
  async getThumbnail(
    presentationId: string, pageObjectId: string, size: "SMALL" | "MEDIUM" | "LARGE" = "LARGE",
  ): Promise<{ contentUrl: string; width: number; height: number }> {
    try {
      const res = await this.slides.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId,
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": size,
      } as slides_v1.Params$Resource$Presentations$Pages$Getthumbnail);
      return {
        contentUrl: res.data.contentUrl ?? "",
        width: res.data.width ?? 0,
        height: res.data.height ?? 0,
      };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Export the whole deck as a PDF buffer. */
  async exportPdf(presentationId: string): Promise<Buffer> {
    try {
      const res = await this.drive.files.export(
        { fileId: presentationId, mimeType: "application/pdf" },
        { responseType: "arraybuffer" },
      );
      return Buffer.from(res.data as ArrayBuffer);
    } catch (err) {
      handleGoogleError(err);
    }
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Copy a template presentation to a new named file.
   * The copy inherits NO sharing — it is owned by the requesting user with
   * default (private) permissions. We never call the Permissions API.
   */
  async duplicatePresentation(templateId: string, newName: string, folderId?: string): Promise<CopiedFile> {
    try {
      const res = await this.drive.files.copy({
        fileId: templateId,
        requestBody: { name: newName, ...(folderId ? { parents: [folderId] } : {}) },
        fields: "id,name,webViewLink",
        supportsAllDrives: true,
      });
      const id = res.data.id ?? "";
      return {
        presentationId: id,
        name: res.data.name ?? newName,
        url: res.data.webViewLink ?? `https://docs.google.com/presentation/d/${id}/edit`,
      };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Find & replace placeholder text across the deck. Returns total occurrences changed. */
  async replaceAllText(presentationId: string, items: Replacement[]): Promise<{ occurrencesChanged: number }> {
    try {
      const res = await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildReplaceAllTextRequests(items) },
      });
      const occurrencesChanged = (res.data.replies ?? []).reduce(
        (sum, r) => sum + (r.replaceAllText?.occurrencesChanged ?? 0), 0,
      );
      return { occurrencesChanged };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /**
   * Overwrite the text of specific table cells.
   * Reads the table first so each cell gets delete+insert (if it has text) or
   * insert-only (if empty) — no fragile error-string retry, no risk of prepending
   * to a non-empty cell in a mixed batch.
   */
  async updateTableCells(presentationId: string, tableObjectId: string, cells: TableCellEdit[]): Promise<{ cellsUpdated: number }> {
    try {
      const p = await this.getPresentation(presentationId);
      const table = findTableElement(p, tableObjectId);
      if (!table) {
        throw new SlidesApiError(`No table found with objectId "${tableObjectId}". Use get_presentation to find it.`, 404);
      }
      await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildTableCellUpdateRequests(tableObjectId, table, cells) },
      });
      return { cellsUpdated: cells.length };
    } catch (err) {
      if (err instanceof SlidesApiError) throw err;
      handleGoogleError(err);
    }
  }

  /** Replace an existing image in place (e.g. a logo). */
  async replaceImage(presentationId: string, imageObjectId: string, url: string): Promise<void> {
    try {
      await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildReplaceImageRequest(imageObjectId, url) },
      });
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Insert a new image onto a slide. Returns the new image object ID. */
  async insertImage(presentationId: string, slideObjectId: string, url: string, box: ElementBox): Promise<{ imageObjectId: string }> {
    try {
      const res = await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildInsertImageRequest(slideObjectId, url, box) },
      });
      return { imageObjectId: res.data.replies?.[0]?.createImage?.objectId ?? "" };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Embed a linked chart from a Google Sheet. Returns the new chart object ID. */
  async embedSheetsChart(
    presentationId: string, slideObjectId: string, spreadsheetId: string, chartId: number, box: ElementBox,
  ): Promise<{ chartObjectId: string }> {
    try {
      const res = await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildEmbedSheetsChartRequest(slideObjectId, spreadsheetId, chartId, box) },
      });
      return { chartObjectId: res.data.replies?.[0]?.createSheetsChart?.objectId ?? "" };
    } catch (err) {
      handleGoogleError(err);
    }
  }

  /** Refresh every linked Sheets chart in the deck so it pulls the latest Sheet data. */
  async refreshSheetsCharts(presentationId: string): Promise<{ chartsRefreshed: number }> {
    try {
      const p = await this.getPresentation(presentationId);
      const chartIds = findSheetsChartObjectIds(p);
      if (chartIds.length === 0) return { chartsRefreshed: 0 };
      await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: buildRefreshChartRequests(chartIds) },
      });
      return { chartsRefreshed: chartIds.length };
    } catch (err) {
      if (err instanceof SlidesApiError) throw err;
      handleGoogleError(err);
    }
  }
}
