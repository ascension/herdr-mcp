import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HerdrApi } from "./herdr-client.js";
import { AGENT_STATUSES, PANE_READ_SOURCES, type RawAgent, type TabLayout } from "./protocol.js";
import { shapeAgent, shapeFullLayout, type WorkspaceLayoutView } from "./views.js";

const SEND_EVIDENCE_DELAY_MS = 500;
const SEND_EVIDENCE_LINES = 15;

function ok(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Resolve an agent_id (pane id) to a live agent, so mutating tools never act
 * on a hallucinated or stale target. Returns undefined when no agent runs in
 * that pane.
 */
async function resolveAgent(client: HerdrApi, agentId: string): Promise<RawAgent | undefined> {
  const agents = await client.listAgents();
  return agents.find((agent) => agent.pane_id === agentId);
}

/** Assemble the full workspace → tab → pane tree with split geometry. */
async function fullLayout(client: HerdrApi): Promise<WorkspaceLayoutView[]> {
  const [workspaces, tabs, panes] = await Promise.all([
    client.listWorkspaces(),
    client.listTabs(),
    client.listPanes(),
  ]);
  const layouts = await Promise.all(
    tabs.map(async (tab) => [tab.tab_id, await client.exportLayout(tab.tab_id)] as const),
  );
  return shapeFullLayout(workspaces, tabs, panes, new Map<string, TabLayout>(layouts));
}

/** Focus a tab, run fn, then restore the previously focused tab. */
async function focusTabThen(client: HerdrApi, tabId: string, fn: () => Promise<unknown>): Promise<void> {
  const tabs = await client.listTabs();
  const previous = tabs.find((tab) => tab.focused);
  await client.call("tab.focus", { tab_id: tabId });
  try {
    await fn();
  } finally {
    if (previous && previous.tab_id !== tabId) {
      await client.call("tab.focus", { tab_id: previous.tab_id });
    }
  }
}

/**
 * Wait until the agent's status is one of `wanted`, driven by Herdr's event
 * stream. Resolves with the matching status, or undefined on timeout. Events
 * only signal *that* something changed; the authoritative status is re-read
 * via agent.get rather than trusted from the event payload.
 */
async function waitForStatus(
  client: HerdrApi,
  agentId: string,
  wanted: ReadonlySet<string>,
  timeoutMs: number,
): Promise<string | undefined> {
  let subscription: { close(): void } | undefined;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      const finish = (value: string | undefined): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const checkNow = (): Promise<void> =>
        client.getAgent(agentId).then(
          (agent) => {
            if (wanted.has(agent.agent_status)) finish(agent.agent_status);
          },
          // Agent gone (pane closed) — nothing left to wait for.
          () => finish(undefined),
        );

      client
        .subscribeAgentStatus(agentId, () => void checkNow())
        .then((sub) => {
          subscription = sub;
          // Close the race: the status may have changed while we subscribed.
          return checkNow();
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } finally {
    subscription?.close();
  }
}

function registerReadTools(server: McpServer, client: HerdrApi): void {
  server.registerTool(
    "list_agents",
    {
      title: "List Herdr agents",
      description:
        "List all coding agents running in Herdr with their live status " +
        "(working / blocked / done / idle) and the agent_id needed to target them " +
        "with other tools. Call this first to discover agents, and to check whether " +
        "any agent is waiting on input.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const agents = await client.listAgents();
      if (agents.length === 0) {
        return ok("No agents are currently running in Herdr (the server is up, but no pane hosts an agent).");
      }
      return ok(agents.map(shapeAgent));
    },
  );

  server.registerTool(
    "get_layout",
    {
      title: "Get the full Herdr layout",
      description:
        "The complete structure: workspaces → tabs → panes, including split " +
        "directions and ratios. Every pane is marked as 'agent' (with status) or " +
        "'shell', so you can see where agents live and which panes are safe " +
        "scratch space. Call this before reorganizing anything or when you need " +
        "panes that list_agents doesn't show.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(await fullLayout(client)),
  );

  server.registerTool(
    "read_pane",
    {
      title: "Read a Herdr pane's screen",
      description:
        "Read the terminal output of any pane (agent or shell). Use it to see what " +
        "an agent is doing, why it is blocked, or to verify the effect of input you " +
        "sent. pane_id comes from list_agents (agent_id) or get_layout.",
      inputSchema: {
        pane_id: z.string().describe('Target pane, e.g. "w1:p1" (agent_id and pane_id are the same handle)'),
        source: z
          .enum(PANE_READ_SOURCES)
          .default("visible")
          .describe(
            '"visible": what\'s on screen now; "recent": scrollback; ' +
              '"detection": the snapshot Herdr\'s status classifier reads',
          ),
        lines: z.number().int().min(1).max(2000).default(60).describe("Number of lines to read"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pane_id, source, lines }) => {
      const read = await client.readPane(pane_id, source, lines);
      return ok(read.text);
    },
  );

  server.registerTool(
    "wait_for_agent_status",
    {
      title: "Wait for an agent's status to change",
      description:
        "Block until an agent reaches one of the given statuses (or the timeout " +
        "expires), using Herdr's event stream instead of polling. Use it after " +
        "sending an agent a task to be notified when it is done or blocked. " +
        "Returns the agent's status either way — a timeout is not an error.",
      inputSchema: {
        agent_id: z.string().describe('Target agent_id from list_agents (e.g. "w1:p1")'),
        until: z
          .array(z.enum(AGENT_STATUSES))
          .min(1)
          .default(["blocked", "done", "idle"])
          .describe("Statuses to wait for"),
        timeout_seconds: z.number().min(1).max(600).default(120),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agent_id, until, timeout_seconds }) => {
      const wanted = new Set<string>(until);

      const current = await resolveAgent(client, agent_id);
      if (!current) {
        return fail(`No agent is running in pane "${agent_id}". Call list_agents for valid targets.`);
      }
      if (wanted.has(current.agent_status)) {
        return ok({ agent_id, status: current.agent_status, waited: false });
      }

      const status = await waitForStatus(client, agent_id, wanted, timeout_seconds * 1000);
      if (status !== undefined) {
        return ok({ agent_id, status, waited: true });
      }
      const latest = await resolveAgent(client, agent_id);
      return ok({
        agent_id,
        status: latest?.agent_status ?? "unknown (agent gone)",
        waited: true,
        timed_out: true,
        note: `Did not reach [${until.join(", ")}] within ${timeout_seconds}s.`,
      });
    },
  );

  server.registerTool(
    "wait_for_output",
    {
      title: "Wait for text to appear in a pane",
      description:
        "Block until a pane's output matches a substring or regex, or the timeout " +
        "expires. Useful for shells and long-running commands where agent status " +
        "doesn't apply (e.g. wait for 'tests passed' or a prompt to return). " +
        "A timeout is reported, not thrown.",
      inputSchema: {
        pane_id: z.string().describe("Target pane from get_layout or list_agents"),
        match: z.string().describe("Text to wait for"),
        regex: z.boolean().default(false).describe("Treat match as a regular expression"),
        timeout_seconds: z.number().min(1).max(600).default(60),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pane_id, match, regex, timeout_seconds }) => {
      const request = client.call(
        "pane.wait_for_output",
        {
          pane_id,
          source: "visible",
          match: { type: regex ? "regex" : "substring", value: match },
          timeout_ms: timeout_seconds * 1000,
        },
        // Long-poll: must not block the shared request queue.
        { dedicated: true },
      );
      // Guard with our own timer: if the server ignores timeout_ms, the tool
      // call must still return instead of hanging Claude's turn.
      const timeout = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), timeout_seconds * 1000 + 500);
      });
      try {
        const result = await Promise.race([request, timeout]);
        if (result === "timeout") {
          return ok({ pane_id, matched: false, timed_out: true, match });
        }
        return ok({ pane_id, matched: true, detail: result });
      } catch (error) {
        // The server answers a missed deadline with an error; that's a
        // normal outcome for this tool, not a failure.
        if (error instanceof Error && /time(d\s*)?out/i.test(error.message)) {
          return ok({ pane_id, matched: false, timed_out: true, match });
        }
        throw error;
      }
    },
  );
}

function registerActTools(server: McpServer, client: HerdrApi): void {
  server.registerTool(
    "send_to_agent",
    {
      title: "Send input to a Herdr agent",
      description:
        "Submit a prompt to a live agent, or type text into its terminal. " +
        "THIS ACTS on a real session — only target an agent_id observed via a " +
        "recent list_agents call, and do not use it to answer questions about an " +
        "agent (use read_pane for that). With submit=true the prompt is delivered " +
        "atomically (text + Enter as one operation) and the server refuses if the " +
        "agent is blocked on input; wait_seconds makes it block until the agent " +
        "settles. With submit=false the text is typed but left unsubmitted for a " +
        "human to review. Returns the pane's screen afterwards so you can verify " +
        "the effect.",
      inputSchema: {
        agent_id: z.string().describe('Target agent_id from list_agents (e.g. "w1:p1")'),
        text: z.string().min(1).describe("The prompt text, without a trailing newline"),
        submit: z
          .boolean()
          .describe("true: submit the prompt (atomic, refuses blocked agents); false: type only, leave un-submitted"),
        wait_seconds: z
          .number()
          .min(1)
          .max(600)
          .optional()
          .describe(
            "With submit=true only: block until the agent reaches idle/blocked/done " +
              "or this many seconds pass",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ agent_id, text, submit, wait_seconds }) => {
      const agent = await resolveAgent(client, agent_id);
      if (!agent) {
        const known = (await client.listAgents()).map((a) => a.pane_id);
        return fail(
          `No agent is running in pane "${agent_id}". Known agent_ids: ` +
            `${known.length ? known.join(", ") : "(none)"}. Call list_agents and retry with a real target.`,
        );
      }

      if (submit) {
        await client.call("agent.prompt", {
          target: agent_id,
          text,
          ...(wait_seconds
            ? { wait: { until: ["idle", "blocked", "done"], timeout_ms: wait_seconds * 1000 } }
            : {}),
        });
      } else {
        await client.sendText(agent_id, text);
      }

      // Evidence over trust: show what actually landed in the pane.
      await new Promise((resolve) => setTimeout(resolve, SEND_EVIDENCE_DELAY_MS));
      const read = await client.readPane(agent_id, "visible", SEND_EVIDENCE_LINES);
      return ok(
        `Sent to ${agent_id} (${agent.agent ?? "unknown"}, was ${agent.agent_status}; submit=${submit}).\n` +
          `Pane now shows:\n---\n${read.text}`,
      );
    },
  );

  server.registerTool(
    "send_keys",
    {
      title: "Send key presses to a pane",
      description:
        "Send named keys (not text) to any pane — e.g. ['enter'] to submit what's " +
        "already typed, ['c-c'] to interrupt a running command, ['escape'] to back " +
        "out of a menu. THIS ACTS on a real session; check the pane with read_pane " +
        "first. Returns the pane's screen afterwards.",
      inputSchema: {
        pane_id: z.string().describe("Target pane from get_layout or list_agents"),
        keys: z
          .array(z.string())
          .min(1)
          .describe('Key names in order, e.g. ["enter"], ["c-c"], ["escape"], ["up","enter"]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ pane_id, keys }) => {
      await client.call("pane.send_keys", { pane_id, keys });
      await new Promise((resolve) => setTimeout(resolve, SEND_EVIDENCE_DELAY_MS));
      const read = await client.readPane(pane_id, "visible", SEND_EVIDENCE_LINES);
      return ok(`Sent keys [${keys.join(", ")}] to ${pane_id}.\nPane now shows:\n---\n${read.text}`);
    },
  );

  server.registerTool(
    "start_agent",
    {
      title: "Start a new agent",
      description:
        "Launch a coding agent in Herdr. kind is a registered agent kind " +
        '(claude, codex, devin, pi, grok, cursor, gemini, muse, aider, amp, …; ' +
        "`herdr agent start --help` lists the live set). Without pane_id, a new " +
        "shell pane is split off the focused pane — cwd and direction apply to " +
        "the split — and the agent launches into it; pane_id targets an existing " +
        "shell pane instead. Returns the new agent's pane so you can immediately " +
        "send_to_agent / wait_for_agent_status it.",
      inputSchema: {
        kind: z.string().describe('Agent kind registered in Herdr, e.g. "claude", "codex", "pi", "devin"'),
        name: z.string().optional().describe("Display name for the agent (defaults to kind)"),
        args: z.array(z.string()).optional().describe("Extra arguments for the agent command"),
        pane_id: z
          .string()
          .optional()
          .describe("Existing shell pane to launch into; omit to split a new pane"),
        cwd: z.string().optional().describe("Working directory (only when splitting a new pane)"),
        direction: z
          .enum(["right", "down"])
          .default("right")
          .describe("Split direction (only when splitting a new pane)"),
        timeout_seconds: z
          .number()
          .min(4)
          .max(300)
          .default(30)
          .describe("How long Herdr waits for the pane to become a usable shell"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ kind, name, args, pane_id, cwd, direction, timeout_seconds }) => {
      let target = pane_id;
      if (!target) {
        const split = await client.call("pane.split", { direction, ...(cwd ? { cwd } : {}) });
        const pane = split["pane"];
        const id =
          typeof pane === "object" && pane !== null
            ? (pane as Record<string, unknown>)["pane_id"]
            : undefined;
        if (typeof id !== "string") {
          return fail(`pane.split returned no pane_id: ${JSON.stringify(split)}`);
        }
        target = id;
      }
      // A fresh split pane is not an "available shell" until its prompt is up;
      // retry through that window, bounded by timeout_seconds.
      const deadline = Date.now() + timeout_seconds * 1000;
      try {
        for (;;) {
          try {
            return ok(
              await client.call("agent.start", {
                name: name ?? kind,
                kind,
                pane_id: target,
                timeout_ms: timeout_seconds * 1000,
                ...(args?.length ? { args } : {}),
              }),
            );
          } catch (error) {
            const retryable =
              error instanceof Error && /not an available shell/i.test(error.message);
            if (!retryable || Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
      } catch (error) {
        // Don't orphan the shell pane we split when the launch itself fails.
        if (!pane_id) await client.call("pane.close", { pane_id: target }).catch(() => {});
        throw error;
      }
    },
  );

  server.registerTool(
    "edit_layout",
    {
      title: "Rearrange panes",
      description:
        "Restructure the pane layout. Actions: " +
        "'split' (new pane beside the focused pane of tab_id; direction right|down), " +
        "'move' (send pane_id to another tab, a new_tab, or a new_workspace), " +
        "'swap' (exchange pane_id with target_pane_id), " +
        "'resize' (grow the focused pane toward direction), " +
        "'zoom' (toggle a pane full-tab), " +
        "'close_pane' (DESTRUCTIVE: kills the pane's session; refused for panes " +
        "hosting agents). Get pane ids from get_layout first. " +
        "Returns the resulting layout as evidence.",
      inputSchema: {
        action: z.enum(["split", "move", "swap", "resize", "zoom", "close_pane"]),
        pane_id: z.string().optional().describe("Primary pane (move/swap/zoom/close_pane)"),
        target_pane_id: z.string().optional().describe("Second pane for swap"),
        tab_id: z.string().optional().describe("Tab to act in (split) or move destination tab (move)"),
        direction: z
          .enum(["right", "down", "left", "up"])
          .optional()
          .describe(
            "split: right|down; resize: any; move to existing tab: placement right|down (default right)",
          ),
        to: z
          .enum(["tab", "new_tab", "new_workspace"])
          .optional()
          .describe("move destination kind ('tab' requires tab_id)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, pane_id, target_pane_id, tab_id, direction, to }) => {
      switch (action) {
        case "split": {
          if (direction !== "right" && direction !== "down") {
            return fail("split needs direction right|down");
          }
          if (tab_id) {
            await focusTabThen(client, tab_id, () => client.call("pane.split", { direction }));
          } else {
            await client.call("pane.split", { direction });
          }
          break;
        }
        case "move": {
          if (!pane_id || !to) return fail("move needs pane_id and 'to'");
          if (to === "tab" && !tab_id) return fail("move to 'tab' needs tab_id");
          // Merging into an existing tab requires a placement split.
          const destination =
            to === "tab"
              ? { type: "tab", tab_id, split: direction === "down" ? "down" : "right" }
              : { type: to };
          await client.call("pane.move", { pane_id, destination });
          break;
        }
        case "swap": {
          if (!pane_id || !target_pane_id) return fail("swap needs pane_id and target_pane_id");
          await client.call("pane.swap", { source_pane_id: pane_id, target_pane_id });
          break;
        }
        case "resize": {
          if (!direction) return fail("resize needs direction");
          await client.call("pane.resize", { direction });
          break;
        }
        case "zoom": {
          await client.call("pane.zoom", pane_id ? { pane_id } : {});
          break;
        }
        case "close_pane": {
          if (!pane_id) return fail("close_pane needs pane_id");
          const agent = await resolveAgent(client, pane_id);
          if (agent) {
            return fail(
              `Refusing: pane ${pane_id} hosts a live ${agent.agent ?? "unknown"} agent ` +
                `(${agent.agent_status}); closing it kills the session. If that is really ` +
                "intended, ask the human or use herdr_rpc explicitly.",
            );
          }
          await client.call("pane.close", { pane_id });
          break;
        }
      }
      return ok({ done: action, layout: await fullLayout(client) });
    },
  );

  server.registerTool(
    "manage_tabs",
    {
      title: "Create / rename / focus / close tabs and workspaces",
      description:
        "Manage the containers panes live in. kind 'tab' or 'workspace'; actions " +
        "create, rename, focus, close. close is DESTRUCTIVE (kills every session " +
        "inside; refused while agents are inside). Returns the resulting layout " +
        "as evidence.",
      inputSchema: {
        kind: z.enum(["tab", "workspace"]),
        action: z.enum(["create", "rename", "focus", "close"]),
        id: z.string().optional().describe("tab_id or workspace_id (required except for create)"),
        label: z.string().optional().describe("New label (rename, or optional on create)"),
        workspace_id: z.string().optional().describe("Workspace to create a tab in (create tab only)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ kind, action, id, label, workspace_id }) => {
      if (action !== "create" && !id) return fail(`${action} needs id (${kind}_id)`);
      if (action === "rename" && !label) return fail("rename needs label");

      if (action === "close") {
        const agents = await client.listAgents();
        const key = kind === "tab" ? "tab_id" : "workspace_id";
        const inside = agents.filter((agent) => agent[key] === id);
        if (inside.length > 0) {
          return fail(
            `Refusing: ${kind} ${id} hosts live agents (${inside.map((a) => a.pane_id).join(", ")}). ` +
              "Close or move them explicitly first, or let the human do it.",
          );
        }
      }

      const params: Record<string, unknown> = {};
      if (id) params[kind === "tab" ? "tab_id" : "workspace_id"] = id;
      if (label) params["label"] = label;
      if (kind === "tab" && action === "create" && workspace_id) params["workspace_id"] = workspace_id;

      const result = await client.call(`${kind}.${action}`, params);
      return ok({ done: `${kind}.${action}`, result, layout: await fullLayout(client) });
    },
  );

  server.registerTool(
    "manage_worktrees",
    {
      title: "Git worktrees in Herdr",
      description:
        "Herdr's git-worktree integration: 'list' existing worktrees, 'create' one " +
        "for a branch, 'open' one in a workspace (exactly one of path or branch), " +
        "'remove' one by workspace_id. Useful for giving each agent an isolated " +
        "checkout.",
      inputSchema: {
        action: z.enum(["list", "create", "open", "remove"]),
        branch: z.string().optional().describe("Branch name (create / open)"),
        path: z.string().optional().describe("Worktree path (open)"),
        workspace_id: z.string().optional().describe("Workspace of the worktree (remove)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, branch, path, workspace_id }) => {
      const params: Record<string, unknown> = {};
      if (branch) params["branch"] = branch;
      if (path) params["path"] = path;
      if (workspace_id) params["workspace_id"] = workspace_id;
      return ok(await client.call(`worktree.${action}`, params));
    },
  );

  server.registerTool(
    "notify_user",
    {
      title: "Show a desktop notification",
      description:
        "Surface something to the human via Herdr's notification system — e.g. " +
        "'agent w1:p1 is blocked on a question'. Fire-and-forget; the result says " +
        "whether it was shown (the user may have notifications disabled).",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body }) =>
      ok(await client.call("notification.show", { title, ...(body ? { body } : {}) })),
  );

  server.registerTool(
    "herdr_rpc",
    {
      title: "Raw Herdr socket call (escape hatch)",
      description:
        "Call any Herdr socket method directly with raw params — full API parity " +
        "for methods without a dedicated tool (plugin.*, integration.*, " +
        "pane.process_info, agent.explain, layout.apply, …). No safety rails: " +
        "params go to the server as-is and the result comes back raw. Prefer the " +
        "dedicated tools; use this only when none fits. server.stop is refused.",
      inputSchema: {
        method: z.string().describe('Socket method, e.g. "agent.explain"'),
        params: z.record(z.unknown()).default({}).describe("Params object, matching Herdr's socket API"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ method, params }) => {
      if (method === "server.stop") {
        return fail("Refusing server.stop: it would kill every session Herdr manages.");
      }
      return ok(await client.call(method, params));
    },
  );
}

export function registerHerdrTools(server: McpServer, client: HerdrApi): void {
  registerReadTools(server, client);
  registerActTools(server, client);
}
