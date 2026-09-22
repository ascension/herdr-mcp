import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { HerdrApi, Subscription } from "../src/herdr-client.js";
import type {
  GenericResult,
  HerdrPush,
  PaneRead,
  RawAgent,
  RawPane,
  RawTab,
  RawWorkspace,
  TabLayout,
} from "../src/protocol.js";
import { registerHerdrTools } from "../src/tools.js";

function agent(overrides: Partial<RawAgent> = {}): RawAgent {
  return {
    terminal_id: "term_1",
    agent: "claude",
    agent_status: "working",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: false,
    cwd: "/tmp",
    foreground_cwd: "/tmp",
    ...overrides,
  };
}

/** In-memory HerdrApi: a mutable agent table plus a recorded send log. */
class FakeHerdr implements HerdrApi {
  agents: RawAgent[] = [];
  paneText = "$ echo hello\nhello";
  sent: Array<{ paneId: string; text: string }> = [];
  private listeners = new Map<string, (event: HerdrPush) => void>();

  async listAgents(): Promise<RawAgent[]> {
    return this.agents;
  }

  async getAgent(paneId: string): Promise<RawAgent> {
    const found = this.agents.find((a) => a.pane_id === paneId);
    if (!found) throw new Error(`pane ${paneId} not found`);
    return found;
  }

  workspaces: RawWorkspace[] = [];
  tabs: RawTab[] = [];
  panes: RawPane[] = [];
  layouts = new Map<string, TabLayout>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  callResult: GenericResult = { type: "ok" };
  callResults = new Map<string, GenericResult>();
  callErrors = new Map<string, Error>();
  /** Per-attempt script: each call to the method shifts the next step. */
  callScript = new Map<string, Array<GenericResult | Error>>();

  async listWorkspaces(): Promise<RawWorkspace[]> {
    return this.workspaces;
  }

  async listTabs(): Promise<RawTab[]> {
    return this.tabs;
  }

  async listPanes(): Promise<RawPane[]> {
    return this.panes;
  }

  async exportLayout(tabId: string): Promise<TabLayout> {
    const layout = this.layouts.get(tabId);
    if (!layout) throw new Error(`no layout for ${tabId}`);
    return layout;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<GenericResult> {
    this.calls.push({ method, params });
    const scripted = this.callScript.get(method);
    if (scripted?.length) {
      const step = scripted.shift();
      if (step instanceof Error) throw step;
      if (step) return step;
    }
    const error = this.callErrors.get(method);
    if (error) throw error;
    return this.callResults.get(method) ?? this.callResult;
  }

  async readPane(paneId: string): Promise<PaneRead> {
    return {
      pane_id: paneId,
      workspace_id: "w1",
      tab_id: "w1:t1",
      source: "visible",
      format: "text",
      text: this.paneText,
    };
  }

  async sendText(paneId: string, text: string): Promise<void> {
    this.sent.push({ paneId, text });
  }

  async subscribeAgentStatus(paneId: string, onEvent: (event: HerdrPush) => void): Promise<Subscription> {
    this.listeners.set(paneId, onEvent);
    return { close: () => this.listeners.delete(paneId) };
  }

  setStatus(paneId: string, status: string): void {
    const target = this.agents.find((a) => a.pane_id === paneId);
    if (target) target.agent_status = status;
    this.listeners.get(paneId)?.({ type: "pane.agent_status_changed", pane_id: paneId });
  }
}

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let cleanup: Array<() => Promise<void>> = [];

async function setup(herdr: FakeHerdr): Promise<Client> {
  const server = new McpServer({ name: "herdr-test", version: "0.0.0" });
  registerHerdrTools(server, herdr);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe("list_agents", () => {
  it("returns shaped agents with agent_id as the handle", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:pG", agent_status: "blocked" })];
    const client = await setup(herdr);

    const result = await callTool(client, "list_agents", {});
    const view = JSON.parse(result.content[0]?.text ?? "");
    expect(view).toEqual([
      {
        agent_id: "w1:pG",
        agent: "claude",
        status: "blocked",
        workspace_id: "w1",
        tab_id: "w1:t1",
        cwd: "/tmp",
        focused: false,
      },
    ]);
  });

  it("explains an empty list instead of returning bare []", async () => {
    const client = await setup(new FakeHerdr());
    const result = await callTool(client, "list_agents", {});
    expect(result.content[0]?.text).toMatch(/No agents/);
  });
});

describe("send_to_agent", () => {
  it("refuses targets that are not live agents and lists valid ones", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1" })];
    const client = await setup(herdr);

    const result = await callTool(client, "send_to_agent", {
      agent_id: "w9:p9",
      text: "hello",
      submit: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("w1:p1");
    expect(herdr.sent).toEqual([]);
  });

  it("submits atomically via agent.prompt and types literally when submit=false", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1" })];
    const client = await setup(herdr);

    await callTool(client, "send_to_agent", { agent_id: "w1:p1", text: "run tests", submit: true });
    await callTool(client, "send_to_agent", { agent_id: "w1:p1", text: "draft only", submit: false });

    expect(herdr.calls).toContainEqual({
      method: "agent.prompt",
      params: { target: "w1:p1", text: "run tests" },
    });
    expect(herdr.sent).toEqual([{ paneId: "w1:p1", text: "draft only" }]);
  }, 10_000);

  it("forwards wait_seconds to agent.prompt as a wait option", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1" })];
    const client = await setup(herdr);

    await callTool(client, "send_to_agent", {
      agent_id: "w1:p1",
      text: "run tests",
      submit: true,
      wait_seconds: 30,
    });

    expect(herdr.calls).toContainEqual({
      method: "agent.prompt",
      params: {
        target: "w1:p1",
        text: "run tests",
        wait: { until: ["idle", "blocked", "done"], timeout_ms: 30_000 },
      },
    });
  }, 10_000);
});

describe("start_agent", () => {
  it("splits a shell pane then starts the agent in it", async () => {
    const herdr = new FakeHerdr();
    herdr.callResults.set("pane.split", { type: "pane_info", pane: { pane_id: "w1:p9" } });
    const client = await setup(herdr);

    const result = await callTool(client, "start_agent", { kind: "pi", cwd: "/tmp" });

    expect(result.isError).toBeUndefined();
    expect(herdr.calls).toEqual([
      { method: "pane.split", params: { direction: "right", cwd: "/tmp" } },
      {
        method: "agent.start",
        params: { name: "pi", kind: "pi", pane_id: "w1:p9", timeout_ms: 30_000 },
      },
    ]);
  });

  it("uses a caller-provided pane_id without splitting", async () => {
    const herdr = new FakeHerdr();
    const client = await setup(herdr);

    await callTool(client, "start_agent", {
      kind: "claude",
      name: "reviewer",
      pane_id: "w1:p2",
      args: ["--continue"],
    });

    expect(herdr.calls).toEqual([
      {
        method: "agent.start",
        params: {
          name: "reviewer",
          kind: "claude",
          pane_id: "w1:p2",
          timeout_ms: 30_000,
          args: ["--continue"],
        },
      },
    ]);
  });

  it("retries through the shell-readiness window", async () => {
    const herdr = new FakeHerdr();
    herdr.callScript.set("pane.split", [{ type: "pane_info", pane: { pane_id: "w1:p9" } }]);
    herdr.callScript.set("agent.start", [
      new Error("agent target pane w1:p9 is not an available shell"),
      { type: "agent_started", agent: { pane_id: "w1:p9" } },
    ]);
    const client = await setup(herdr);

    const result = await callTool(client, "start_agent", { kind: "pi" });

    expect(result.isError).toBeUndefined();
    expect(herdr.calls.filter((c) => c.method === "agent.start")).toHaveLength(2);
  }, 10_000);

  it("does not retry a non-shell error and cleans up the split pane", async () => {
    const herdr = new FakeHerdr();
    herdr.callScript.set("pane.split", [{ type: "pane_info", pane: { pane_id: "w1:p9" } }]);
    herdr.callScript.set("agent.start", [new Error("unknown agent kind")]);
    const client = await setup(herdr);

    const result = await callTool(client, "start_agent", { kind: "nope" });

    expect(result.isError).toBe(true);
    expect(herdr.calls.filter((c) => c.method === "agent.start")).toHaveLength(1);
    expect(herdr.calls).toContainEqual({ method: "pane.close", params: { pane_id: "w1:p9" } });
  }, 10_000);

  it("does not close the pane when an agent landed despite the failed call", async () => {
    const herdr = new FakeHerdr();
    herdr.callScript.set("pane.split", [{ type: "pane_info", pane: { pane_id: "w1:p9" } }]);
    herdr.callErrors.set("agent.start", new Error("connection lost"));
    // The lost reply hid a successful start: the pane now hosts a live agent.
    herdr.agents = [agent({ pane_id: "w1:p9", agent_status: "idle" })];
    const client = await setup(herdr);

    const result = await callTool(client, "start_agent", { kind: "pi" });

    expect(result.isError).toBe(true);
    expect(herdr.calls.find((c) => c.method === "pane.close")).toBeUndefined();
  }, 10_000);

});

function populateLayout(herdr: FakeHerdr): void {
  herdr.workspaces = [
    {
      workspace_id: "w1",
      number: 1,
      label: "explore",
      focused: true,
      pane_count: 2,
      tab_count: 1,
      active_tab_id: "w1:t1",
      agent_status: "working",
    },
  ];
  herdr.tabs = [
    {
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: true,
      pane_count: 2,
      agent_status: "working",
    },
  ];
  herdr.panes = [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: true,
      cwd: "/repo",
      agent: "claude",
      agent_status: "working",
    },
    {
      pane_id: "w1:p2",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      cwd: "/repo",
      agent_status: "unknown",
    },
  ];
  herdr.layouts.set("w1:t1", {
    workspace_id: "w1",
    tab_id: "w1:t1",
    zoomed: false,
    focused_pane_id: "w1:p1",
    root: {
      type: "split",
      direction: "down",
      ratio: 0.5,
      first: { type: "pane", pane_id: "w1:p1", cwd: "/repo" },
      second: { type: "pane", pane_id: "w1:p2", cwd: "/repo" },
    },
  });
}

describe("get_layout", () => {
  it("marks agent and shell panes in the split tree", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    const client = await setup(herdr);

    const result = await callTool(client, "get_layout", {});
    const view = JSON.parse(result.content[0]?.text ?? "");
    expect(view[0].tabs[0].layout).toEqual({
      split: "top|bottom",
      ratio: 0.5,
      first: {
        pane_id: "w1:p1",
        role: "agent",
        agent: "claude",
        status: "working",
        cwd: "/repo",
        focused: true,
      },
      second: { pane_id: "w1:p2", role: "shell", cwd: "/repo", focused: false },
    });
  });
});

describe("edit_layout", () => {
  it("refuses to close a pane hosting an agent", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    herdr.agents = [agent({ pane_id: "w1:p1" })];
    const client = await setup(herdr);

    const result = await callTool(client, "edit_layout", { action: "close_pane", pane_id: "w1:p1" });

    expect(result.isError).toBe(true);
    expect(herdr.calls).toEqual([]);
  });

  it("closes a shell pane and returns the layout as evidence", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    const client = await setup(herdr);

    const result = await callTool(client, "edit_layout", { action: "close_pane", pane_id: "w1:p2" });

    expect(herdr.calls).toEqual([{ method: "pane.close", params: { pane_id: "w1:p2" } }]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ done: "close_pane" });
  });

  it("adds the required placement split when moving to an existing tab", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    const client = await setup(herdr);

    await callTool(client, "edit_layout", { action: "move", pane_id: "w1:p2", to: "tab", tab_id: "w1:t1" });
    await callTool(client, "edit_layout", {
      action: "move",
      pane_id: "w1:p2",
      to: "tab",
      tab_id: "w1:t1",
      direction: "down",
    });
    await callTool(client, "edit_layout", { action: "move", pane_id: "w1:p2", to: "new_tab" });

    expect(herdr.calls.map((c) => c.params["destination"])).toEqual([
      { type: "tab", tab_id: "w1:t1", split: "right" },
      { type: "tab", tab_id: "w1:t1", split: "down" },
      { type: "new_tab" },
    ]);
  });

  it("validates per-action required fields", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    const client = await setup(herdr);

    const result = await callTool(client, "edit_layout", { action: "swap", pane_id: "w1:p1" });
    expect(result.isError).toBe(true);
    expect(herdr.calls).toEqual([]);
  });

  it("splits inside a target tab by focusing it and restoring focus", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    herdr.tabs.push({
      tab_id: "w1:t2",
      workspace_id: "w1",
      number: 2,
      label: "2",
      focused: false,
      pane_count: 1,
      agent_status: "unknown",
    });
    herdr.layouts.set("w1:t2", {
      workspace_id: "w1",
      tab_id: "w1:t2",
      zoomed: false,
      focused_pane_id: "w1:p3",
      root: { type: "pane", pane_id: "w1:p3", cwd: "/repo" },
    });
    const client = await setup(herdr);

    await callTool(client, "edit_layout", { action: "split", direction: "right", tab_id: "w1:t2" });

    expect(herdr.calls.map((c) => c.method)).toEqual(["tab.focus", "pane.split", "tab.focus"]);
    expect(herdr.calls[0]?.params).toEqual({ tab_id: "w1:t2" });
    expect(herdr.calls[2]?.params).toEqual({ tab_id: "w1:t1" });
  });
});

describe("manage_tabs", () => {
  it("refuses to close a tab containing agents", async () => {
    const herdr = new FakeHerdr();
    populateLayout(herdr);
    herdr.agents = [agent({ pane_id: "w1:p1", tab_id: "w1:t1" })];
    const client = await setup(herdr);

    const result = await callTool(client, "manage_tabs", { kind: "tab", action: "close", id: "w1:t1" });

    expect(result.isError).toBe(true);
    expect(herdr.calls).toEqual([]);
  });
});

describe("herdr_rpc", () => {
  it("passes method and params through raw", async () => {
    const herdr = new FakeHerdr();
    herdr.callResult = { type: "agent_explain", explain: { agent: "claude" } };
    const client = await setup(herdr);

    const result = await callTool(client, "herdr_rpc", {
      method: "agent.explain",
      params: { target: "w1:p1" },
    });

    expect(herdr.calls).toEqual([{ method: "agent.explain", params: { target: "w1:p1" } }]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ type: "agent_explain" });
  });

  it("refuses server.stop", async () => {
    const herdr = new FakeHerdr();
    const client = await setup(herdr);

    const result = await callTool(client, "herdr_rpc", { method: "server.stop", params: {} });

    expect(result.isError).toBe(true);
    expect(herdr.calls).toEqual([]);
  });
});

describe("wait_for_agent_status", () => {
  it("returns immediately when the status already matches", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1", agent_status: "blocked" })];
    const client = await setup(herdr);

    const result = await callTool(client, "wait_for_agent_status", {
      agent_id: "w1:p1",
      until: ["blocked"],
      timeout_seconds: 5,
    });

    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ status: "blocked", waited: false });
  });

  it("resolves when a status-change event lands", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1", agent_status: "working" })];
    const client = await setup(herdr);

    const pending = callTool(client, "wait_for_agent_status", {
      agent_id: "w1:p1",
      until: ["done"],
      timeout_seconds: 5,
    });
    setTimeout(() => herdr.setStatus("w1:p1", "done"), 50);

    const result = await pending;
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ status: "done", waited: true });
  });

  it("reports a timeout without erroring", async () => {
    const herdr = new FakeHerdr();
    herdr.agents = [agent({ pane_id: "w1:p1", agent_status: "working" })];
    const client = await setup(herdr);

    const result = await callTool(client, "wait_for_agent_status", {
      agent_id: "w1:p1",
      until: ["done"],
      timeout_seconds: 1,
    });

    const payload = JSON.parse(result.content[0]?.text ?? "");
    expect(payload).toMatchObject({ timed_out: true, status: "working" });
    expect(result.isError).toBeUndefined();
  });
});
