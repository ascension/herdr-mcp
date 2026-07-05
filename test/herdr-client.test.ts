import { afterEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../src/herdr-client.js";
import { HerdrError, type HerdrPush } from "../src/protocol.js";
import { FakeHerdrServer, type RequestHandler } from "./fake-herdr-server.js";

const AGENT = {
  terminal_id: "term_1",
  agent: "claude",
  agent_status: "working",
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  focused: false,
  cwd: "/tmp",
  foreground_cwd: "/tmp",
};

const silent = () => {};
let cleanup: Array<() => Promise<void> | void> = [];

async function setup(onRequest: RequestHandler): Promise<{ server: FakeHerdrServer; client: HerdrClient }> {
  const server = new FakeHerdrServer(onRequest);
  await server.listen();
  const client = new HerdrClient({ socketPath: server.socketPath, log: silent });
  cleanup.push(() => client.close());
  cleanup.push(() => server.close());
  return { server, client };
}

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe("HerdrClient", () => {
  it("correlates out-of-order replies by id", async () => {
    const { client } = await setup((request, reply) => {
      const delay = request.method === "agent.list" ? 50 : 0;
      const result =
        request.method === "agent.list"
          ? { type: "agent_list", agents: [AGENT] }
          : { type: "workspace_list", workspaces: [] };
      setTimeout(() => reply({ id: request.id, result }), delay);
    });

    const [agents, workspaces] = await Promise.all([client.listAgents(), client.listWorkspaces()]);
    expect(agents[0]?.pane_id).toBe("w1:p1");
    expect(workspaces).toEqual([]);
  });

  it("surfaces server errors as HerdrError with the code", async () => {
    const { client } = await setup((request, reply) => {
      reply({ id: request.id, error: { code: "pane_not_found", message: "pane w9:p9 not found" } });
    });

    const err = await client.getAgent("w9:p9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("pane_not_found");
  });

  it("rejects on result shape drift", async () => {
    const { client } = await setup((request, reply) => {
      reply({ id: request.id, result: { type: "agent_list", agents: [{ bogus: true }] } });
    });

    await expect(client.listAgents()).rejects.toThrow(/unexpected result/);
  });

  it("retries once on a fresh connection when the server drops mid-request", async () => {
    let dropNext = true;
    const { server, client } = await setup((request, reply) => {
      if (dropNext) {
        dropNext = false;
        server.dropConnections();
        return;
      }
      reply({ id: request.id, result: { type: "agent_list", agents: [] } });
    });

    await expect(client.listAgents()).resolves.toEqual([]);
  });

  it("fails when the server keeps dropping the connection", async () => {
    const { server, client } = await setup(() => {
      server.dropConnections();
    });

    await expect(client.listAgents()).rejects.toThrow();
  });

  it("attributes an empty-id error reply to the pending request", async () => {
    // Herdr answers requests it could not parse with id:"" — the client must
    // surface the real error, not a dropped connection.
    const { client } = await setup((_request, reply) => {
      reply({ id: "", error: { code: "invalid_request", message: "missing field `split`" } });
    });

    const err = await client.listAgents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).message).toContain("split");
  });

  it("does not retry on a server-answered error", async () => {
    let requests = 0;
    const { client } = await setup((request, reply) => {
      requests += 1;
      reply({ id: request.id, error: { code: "pane_not_found", message: "nope" } });
    });

    await expect(client.getAgent("w9:p9")).rejects.toThrow(HerdrError);
    expect(requests).toBe(1);
  });

  it("delivers subscription events on a dedicated connection", async () => {
    const { server, client } = await setup((request, reply) => {
      reply({ id: request.id, result: { type: "subscription_started" } });
    });

    const events: HerdrPush[] = [];
    const subscription = await client.subscribeAgentStatus("w1:p1", (event) => events.push(event));

    server.push({ type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "blocked" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    subscription.close();

    expect(events).toHaveLength(1);
    expect(events[0]?.agent_status).toBe("blocked");
  });
});
