/**
 * Write-enabled Google Slides MCP tools.
 *
 * Registered for every authenticated @example.com user. Per-user OAuth means each
 * user can only edit decks they already have Google permission to edit.
 *
 * Every handler is wrapped with `audited()` (see src/audit.ts) so each write
 * emits a structured log entry (objectsModified + presentationId) and large
 * operations trigger a Slack DM to the security alert user.
 *
 * Deliberately excluded (permission preservation — sensitive board/QBR decks):
 *   - share_presentation / any permission-mutation tool — would allow silently
 *     widening access to a deck. Permanently omitted.
 *   - raw batchUpdate passthrough — unvalidated API surface. Permanently omitted.
 *   - ownership transfer — permanently omitted.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SlidesClient, SlidesApiError } from "../slides-client.js";
import { audited, type WriteScope } from "../audit.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const ElementBoxShape = {
  width_pt: z.number().positive().default(400).describe("Width in points."),
  height_pt: z.number().positive().default(300).describe("Height in points."),
  x_pt: z.number().default(50).describe("X offset from top-left in points."),
  y_pt: z.number().default(50).describe("Y offset from top-left in points."),
};

export function registerWriteTools(server: McpServer, client: SlidesClient, userEmail: string): void {

  // 1. duplicate_presentation — copy a template (stays private)
  server.tool(
    "duplicate_presentation",
    "Copy a template presentation to a new named file. The copy is private to you (no sharing is inherited or added). This is the starting point for templating — duplicate, then replace placeholders.",
    {
      template_id: z.string().min(1).describe("Source/template presentation ID to copy."),
      new_name: z.string().min(1).max(255).describe("Name for the new copy."),
      folder_id: z.string().optional().describe("Optional Drive folder ID to place the copy in. Omit for My Drive."),
    },
    audited(
      "duplicate_presentation",
      userEmail,
      (args): WriteScope => ({ objectsModified: 1, presentationId: args.template_id, detail: `duplicate → "${args.new_name}"` }),
      async ({ template_id, new_name, folder_id }) => {
        try {
          const file = await client.duplicatePresentation(template_id, new_name, folder_id);
          return { content: [{ type: "text" as const, text: JSON.stringify(file, null, 2) }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 2. replace_all_text — templating workhorse
  server.tool(
    "replace_all_text",
    "Find and replace placeholder text across a presentation (e.g. {{account_name}} → Acme). Each replacement is case-sensitive. Optionally scope a replacement to specific slides by objectId.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
      replacements: z.array(z.object({
        find: z.string().min(1).describe("Placeholder text to find, e.g. {{account_name}}."),
        replace: z.string().describe("Replacement value."),
        pageObjectIds: z.array(z.string()).optional().describe("Limit this replacement to specific slide objectIds."),
      })).min(1).max(100).describe("Replacements to apply (max 100)."),
    },
    audited(
      "replace_all_text",
      userEmail,
      (args): WriteScope => ({ objectsModified: args.replacements.length, presentationId: args.presentation_id, detail: `${args.replacements.length} replacement rule(s)` }),
      async ({ presentation_id, replacements }) => {
        try {
          const { occurrencesChanged } = await client.replaceAllText(presentation_id, replacements);
          return {
            content: [{
              type: "text" as const,
              text: `Applied ${replacements.length} replacement rule(s); ${occurrencesChanged} occurrence(s) changed.`,
            }],
          };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 3. update_table_cells — write values into an existing table
  server.tool(
    "update_table_cells",
    "Overwrite the text of specific cells in an existing table (e.g. QBR metrics, board figures). Use get_presentation to find the table's objectId. Row/column indexes are zero-based.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
      table_object_id: z.string().min(1).describe("Object ID of the table (from get_presentation)."),
      cells: z.array(z.object({
        row: z.number().int().min(0).describe("Zero-based row index."),
        column: z.number().int().min(0).describe("Zero-based column index."),
        text: z.string().describe("New cell text."),
      })).min(1).max(200).describe("Cells to update (max 200)."),
    },
    audited(
      "update_table_cells",
      userEmail,
      (args): WriteScope => ({ objectsModified: args.cells.length, presentationId: args.presentation_id, detail: `${args.cells.length} cell(s)` }),
      async ({ presentation_id, table_object_id, cells }) => {
        try {
          const { cellsUpdated } = await client.updateTableCells(presentation_id, table_object_id, cells);
          return { content: [{ type: "text" as const, text: `Updated ${cellsUpdated} cell(s) in table ${table_object_id}.` }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 4. insert_image — add an image to a slide
  server.tool(
    "insert_image",
    "Insert an image onto a slide from a publicly accessible URL (PNG/JPEG, <50MB, <25MP). Use get_presentation to find the slide's objectId. Returns the new image's objectId.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
      slide_object_id: z.string().min(1).describe("Slide objectId to place the image on."),
      url: z.string().url().describe("Publicly accessible image URL."),
      ...ElementBoxShape,
    },
    audited(
      "insert_image",
      userEmail,
      (args): WriteScope => ({ objectsModified: 1, presentationId: args.presentation_id, detail: "insert image" }),
      async ({ presentation_id, slide_object_id, url, width_pt, height_pt, x_pt, y_pt }) => {
        try {
          const { imageObjectId } = await client.insertImage(presentation_id, slide_object_id, url, {
            widthPt: width_pt, heightPt: height_pt, xPt: x_pt, yPt: y_pt,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ imageObjectId }, null, 2) }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 5. replace_image — swap an image in place
  server.tool(
    "replace_image",
    "Replace an existing image in place with a new one from a URL (e.g. swap an account logo). Use get_presentation to find the image's objectId.",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
      image_object_id: z.string().min(1).describe("Object ID of the existing image to replace."),
      url: z.string().url().describe("Publicly accessible image URL (PNG/JPEG, <50MB, <25MP)."),
    },
    audited(
      "replace_image",
      userEmail,
      (args): WriteScope => ({ objectsModified: 1, presentationId: args.presentation_id, detail: "replace image" }),
      async ({ presentation_id, image_object_id, url }) => {
        try {
          await client.replaceImage(presentation_id, image_object_id, url);
          return { content: [{ type: "text" as const, text: `Replaced image ${image_object_id}.` }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 6. embed_sheets_chart — embed a linked chart from a Google Sheet
  server.tool(
    "embed_sheets_chart",
    "Embed a chart from a Google Sheet onto a slide as a LINKED chart, so it can later be refreshed in place when the Sheet's data changes. Use get_presentation for the slide objectId; get the chart_id from the source Sheet (e.g. via the Sheets MCP).",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
      slide_object_id: z.string().min(1).describe("Slide objectId to place the chart on."),
      spreadsheet_id: z.string().min(1).describe("Source Google Sheet ID."),
      chart_id: z.number().int().describe("Numeric chart ID within the source Sheet."),
      ...ElementBoxShape,
    },
    audited(
      "embed_sheets_chart",
      userEmail,
      (args): WriteScope => ({ objectsModified: 1, presentationId: args.presentation_id, detail: "embed linked chart" }),
      async ({ presentation_id, slide_object_id, spreadsheet_id, chart_id, width_pt, height_pt, x_pt, y_pt }) => {
        try {
          const { chartObjectId } = await client.embedSheetsChart(presentation_id, slide_object_id, spreadsheet_id, chart_id, {
            widthPt: width_pt, heightPt: height_pt, xPt: x_pt, yPt: y_pt,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ chartObjectId }, null, 2) }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );

  // 7. refresh_sheets_charts — re-pull all linked charts
  server.tool(
    "refresh_sheets_charts",
    "Refresh every linked Google Sheets chart in the presentation so each pulls the latest data from its source Sheet. Use after the underlying numbers change (e.g. before sending a board deck).",
    {
      presentation_id: z.string().min(1).describe("The presentation ID."),
    },
    audited(
      "refresh_sheets_charts",
      userEmail,
      (args): WriteScope => ({ objectsModified: 1, presentationId: args.presentation_id, detail: "refresh linked charts" }),
      async ({ presentation_id }) => {
        try {
          const { chartsRefreshed } = await client.refreshSheetsCharts(presentation_id);
          return { content: [{ type: "text" as const, text: `Refreshed ${chartsRefreshed} linked chart(s).` }] };
        } catch (err) {
          return toolError(err instanceof SlidesApiError ? err.message : String(err));
        }
      },
    ),
  );
}
