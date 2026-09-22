import { z } from "zod";

/**
 * Wire types for Herdr's socket API (newline-delimited JSON-RPC over a Unix
 * domain socket). Shapes verified against Herdr 0.9.1, socket protocol 22.
 */

export interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

/** A server-pushed line that is not a reply to a pending request. */
export interface HerdrPush {
  type: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A line correlated to a request we sent: has a string `id`. */
export function isHerdrResponse(value: unknown): value is HerdrResponse {
  if (!isRecord(value) || typeof value["id"] !== "string") return false;
  const error = value["error"];
  if (error !== undefined) {
    return isRecord(error) && typeof error["code"] === "string" && typeof error["message"] === "string";
  }
  return true;
}

/**
 * A server-initiated line (event push): no request id, and either a string
 * `type` (pre-0.9 shape) or `event` (protocol 22 shape `{event, data}`).
 */
export function isHerdrPush(value: unknown): value is HerdrPush {
  return (
    isRecord(value) &&
    (typeof value["type"] === "string" || typeof value["event"] === "string")
  );
}

/** Normalize a protocol-22 `{event, data}` push onto `type` for consumers. */
export function pushType(push: HerdrPush): string {
  const type = push["type"];
  if (typeof type === "string") return type;
  const event = push["event"];
  return typeof event === "string" ? event : "unknown";
}

/** An error returned by the Herdr server (e.g. pane_not_found). */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

// ---- result payload schemas (validated at the client boundary) ----
// Herdr may add fields across versions; schemas are non-strict on purpose.

export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

/** Known statuses plus room for values newer Herdr versions may add. */
export const agentStatusSchema = z.string();
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const rawAgentSchema = z.object({
  terminal_id: z.string(),
  // Absent while the pane's agent is still launching (launch_pending).
  agent: z.string().optional(),
  name: z.string().optional(),
  agent_status: agentStatusSchema,
  workspace_id: z.string(),
  tab_id: z.string(),
  pane_id: z.string(),
  focused: z.boolean(),
  cwd: z.string(),
  foreground_cwd: z.string().optional(),
});
export type RawAgent = z.infer<typeof rawAgentSchema>;

export const agentListResultSchema = z.object({
  type: z.literal("agent_list"),
  agents: z.array(rawAgentSchema),
});

export const agentInfoResultSchema = z.object({
  type: z.literal("agent_info"),
  agent: rawAgentSchema,
});

export const PANE_READ_SOURCES = ["visible", "recent", "recent-unwrapped", "detection"] as const;
export type PaneReadSource = (typeof PANE_READ_SOURCES)[number];

export const paneReadResultSchema = z.object({
  type: z.literal("pane_read"),
  read: z.object({
    pane_id: z.string(),
    workspace_id: z.string(),
    tab_id: z.string(),
    source: z.string(),
    format: z.string(),
    text: z.string(),
  }),
});
export type PaneRead = z.infer<typeof paneReadResultSchema>["read"];

export const rawWorkspaceSchema = z.object({
  workspace_id: z.string(),
  number: z.number(),
  label: z.string(),
  focused: z.boolean(),
  pane_count: z.number(),
  tab_count: z.number(),
  active_tab_id: z.string(),
  agent_status: agentStatusSchema,
});
export type RawWorkspace = z.infer<typeof rawWorkspaceSchema>;

export const workspaceListResultSchema = z.object({
  type: z.literal("workspace_list"),
  workspaces: z.array(rawWorkspaceSchema),
});

export const rawPaneSchema = z.object({
  pane_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  focused: z.boolean(),
  cwd: z.string(),
  agent: z.string().optional(),
  agent_status: agentStatusSchema,
});
export type RawPane = z.infer<typeof rawPaneSchema>;

export const paneListResultSchema = z.object({
  type: z.literal("pane_list"),
  panes: z.array(rawPaneSchema),
});

export const rawTabSchema = z.object({
  tab_id: z.string(),
  workspace_id: z.string(),
  number: z.number(),
  label: z.string(),
  focused: z.boolean(),
  pane_count: z.number(),
  agent_status: agentStatusSchema,
});
export type RawTab = z.infer<typeof rawTabSchema>;

export const tabListResultSchema = z.object({
  type: z.literal("tab_list"),
  tabs: z.array(rawTabSchema),
});

export interface LayoutNode {
  type: "pane" | "split";
  pane_id?: string;
  cwd?: string;
  direction?: "right" | "down";
  ratio?: number;
  first?: LayoutNode;
  second?: LayoutNode;
}

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("pane"), pane_id: z.string(), cwd: z.string() }),
    z.object({
      type: z.literal("split"),
      direction: z.enum(["right", "down"]),
      ratio: z.number(),
      first: layoutNodeSchema,
      second: layoutNodeSchema,
    }),
  ]),
);

export const layoutExportResultSchema = z.object({
  type: z.literal("layout_export"),
  layout: z.object({
    workspace_id: z.string(),
    tab_id: z.string(),
    zoomed: z.boolean(),
    focused_pane_id: z.string(),
    root: layoutNodeSchema,
  }),
});
export type TabLayout = z.infer<typeof layoutExportResultSchema>["layout"];

/** Mutation acks vary by method; only the discriminating `type` is required. */
export const genericResultSchema = z.object({ type: z.string() }).catchall(z.unknown());
export type GenericResult = z.infer<typeof genericResultSchema>;

/**
 * Parse a socket result against a schema, failing with a message that names
 * the method — a malformed result means a Herdr version drift, and the error
 * should say so instead of surfacing a bare zod trace.
 */
export function parseResult<T>(method: string, schema: z.ZodType<T>, result: unknown): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new HerdrError(
      "unexpected_result_shape",
      `Herdr returned an unexpected result for ${method} (version drift?): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
