/**
 * Read-only Google Slides MCP tools — available to every authenticated @example.com user.
 *
 * Per-user OAuth means each user can only read decks they already have Google
 * permission to view. Google returns 403 (surfaced as a clear message) otherwise.
 *
 *   get_presentation        — slimmed outline: slide + element object IDs (needed to target edits)
 *   get_presentation_text   — all slide text + speaker notes as markdown
 *   export_presentation_pdf — whole deck as a downloadable PDF
 *   get_slide_thumbnail     — PNG preview URL for one slide
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SlidesClient, SlidesApiError } from "../slides-client.js";

/**
 * Max PDF size returned inline (base64). Larger decks should be downloaded from
 * Drive directly. Kept conservative because base64 (~1.33x) flows back through the
 * MCP transport and Claude.ai response limits bite well before raw byte size.
 */
const MAX_PDF_BYTES = 8 * 1024 * 1024;

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerReadTools(server: McpServer, client: SlidesClient): void {

  // 1. get_presentation — outline with object IDs
  server.tool(
    "get_presentation",
    "Get the structure of a Google Slides presentation: title, slide count, and for each slide its objectId plus every element's objectId, kind (shape/table/image/sheetsChart), and text. Use this first to find the object IDs needed by edit tools.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID (from the deck URL)."),
    },
    async ({ presentation_id }) => {
      try {
        const outline = await client.getOutline(presentation_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(outline, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof SlidesApiError ? err.message : String(err));
      }
    },
  );

  // 2. get_presentation_text — text + speaker notes
  server.tool(
    "get_presentation_text",
    "Extract all text content and speaker notes from a presentation, rendered as markdown (one section per slide). Useful for summarizing or verifying placeholder text before a replace.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID (from the deck URL)."),
    },
    async ({ presentation_id }) => {
      try {
        const text = await client.getText(presentation_id);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return toolError(err instanceof SlidesApiError ? err.message : String(err));
      }
    },
  );

  // 3. export_presentation_pdf — whole deck as PDF
  server.tool(
    "export_presentation_pdf",
    "Export the entire presentation as a PDF. Returns the PDF as a downloadable resource. For very large decks the deck can instead be downloaded directly from Google Drive.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID (from the deck URL)."),
    },
    async ({ presentation_id }) => {
      try {
        const buf = await client.exportPdf(presentation_id);
        if (buf.byteLength > MAX_PDF_BYTES) {
          return toolError(
            `PDF is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB, exceeding the ${MAX_PDF_BYTES / 1024 / 1024} MB inline limit. ` +
            `Download it directly from Google Drive instead.`,
          );
        }
        return {
          content: [
            { type: "text" as const, text: `Exported presentation as PDF (${(buf.byteLength / 1024).toFixed(0)} KB).` },
            {
              type: "resource" as const,
              resource: {
                uri: `presentation://${presentation_id}.pdf`,
                mimeType: "application/pdf",
                blob: buf.toString("base64"),
              },
            },
          ],
        };
      } catch (err) {
        return toolError(err instanceof SlidesApiError ? err.message : String(err));
      }
    },
  );

  // 4. get_slide_thumbnail — PNG preview URL for one slide
  server.tool(
    "get_slide_thumbnail",
    "Generate a PNG thumbnail of a single slide and return its temporary image URL. Use get_presentation first to find the slide's objectId. The URL expires after a short time.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID (from the deck URL)."),
      slide_object_id: z.string().min(1).describe("The slide's objectId (from get_presentation)."),
      size: z.enum(["SMALL", "MEDIUM", "LARGE"]).default("LARGE").describe("Thumbnail size."),
    },
    async ({ presentation_id, slide_object_id, size }) => {
      try {
        const t = await client.getThumbnail(presentation_id, slide_object_id, size);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ contentUrl: t.contentUrl, width: t.width, height: t.height }, null, 2),
          }],
        };
      } catch (err) {
        return toolError(err instanceof SlidesApiError ? err.message : String(err));
      }
    },
  );
}
