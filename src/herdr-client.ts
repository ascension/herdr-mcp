import os from "node:os";
import path from "node:path";
import { HerdrConnection, type Logger } from "./connection.js";
import {
  type AgentStatus,
  agentInfoResultSchema,
  agentListResultSchema,
  type GenericResult,
  genericResultSchema,
  HerdrError,
  type HerdrPush,
  layoutExportResultSchema,
  type PaneRead,
  type PaneReadSource,
  paneListResultSchema,
  paneReadResultSchema,
  parseResult,
  type RawAgent,
  type RawPane,
  type RawTab,
  type RawWorkspace,
  type TabLayout,
  tabListResultSchema,
  workspaceListResultSchema,
} from "./protocol.js";

export const DEFAULT_SOCKET_PATH = path.join(os.homedir(), ".config", "herdr", "herdr.sock");

export interface Subscription {
  close(): void;
}

/**
 * The Herdr surface the tools depend on. Kept as an interface so tools can be
 * tested against a fake and so alternative transports can slot in later.
 */
export interface HerdrApi {
  listAgents(): Promise<RawAgent[]>;
  getAgent(paneId: string): Promise<RawAgent>;
  listWorkspaces(): Promise<RawWorkspace[]>;
  listTabs(): Promise<RawTab[]>;
  listPanes(): Promise<RawPane[]>;
  exportLayout(tabId: string): Promise<TabLayout>;
  readPane(paneId: string, source: PaneReadSource, lines: number): Promise<PaneRead>;
  sendText(paneId: string, text: string): Promise<void>;
  subscribeAgentStatus(paneId: string, onEvent: (event: HerdrPush) => void): Promise<Subscription>;
  /**
   * Any other socket method, minimally validated (`{ type }` plus whatever
   * the server adds). Mutating tools compose on this instead of one wrapper
   * per method. Pass `dedicated: true` for long-polling methods (e.g.
   * pane.wait_for_output) so they don't block the serialized request queue.
   */
  call(
    method: string,
    params?: Record<string, unknown>,
    opts?: { dedicated?: boolean },
  ): Promise<GenericResult>;
}

export interface HerdrClientOptions {
  socketPath?: string;
  log?: Logger;
}

/**
 * High-level Herdr API client. Maintains one lazily-connected request
 * connection (re-established transparently after a drop) and opens a
 * dedicated connection per event subscription, since a subscription turns
 * a connection into a long-lived stream.
 */
export class HerdrClient implements HerdrApi {
  private readonly socketPath: string;
  private readonly log: Logger;
  private connection: HerdrConnection | undefined;
  private connecting: Promise<HerdrConnection> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.log = options.log ?? ((msg) => process.stderr.write(`${msg}\n`));
  }

  /**
   * Herdr closes the connection after replying (observed on 0.7.x and 0.9.1),
   * which makes concurrent requests on one connection impossible — so requests
   * are serialized through a queue, and a request that still raced a close is
   * retried once on a fresh connection. HerdrErrors are real server answers
   * and are never retried. `noRetry` is for non-idempotent methods: a request
   * lost after the server processed it must not be re-issued.
   */
  request(
    method: string,
    params: Record<string, unknown> = {},
    opts: { noRetry?: boolean } = {},
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      try {
        const connection = await this.ensureConnection();
        return await connection.request(method, params);
      } catch (error) {
        if (error instanceof HerdrError) throw error;
        // `unsent` marks a write that provably never reached the server — safe
        // to re-issue even when the method mutates.
        const unsent = (error as { unsent?: boolean }).unsent === true;
        if (opts.noRetry && !unsent) throw error;
        const connection = await this.ensureConnection();
        return connection.request(method, params);
      }
    };
    const result = this.queue.then(run, run);
    // The queue must survive failures; errors still reach the caller via `result`.
    this.queue = result.catch(() => {});
    return result;
  }

  // ---- typed wrappers over the socket methods the tools need ----

  async listAgents(): Promise<RawAgent[]> {
    const res = await this.request("agent.list");
    return parseResult("agent.list", agentListResultSchema, res).agents;
  }

  async getAgent(paneId: string): Promise<RawAgent> {
    const res = await this.request("agent.get", { target: paneId });
    return parseResult("agent.get", agentInfoResultSchema, res).agent;
  }

  async listWorkspaces(): Promise<RawWorkspace[]> {
    const res = await this.request("workspace.list");
    return parseResult("workspace.list", workspaceListResultSchema, res).workspaces;
  }

  async listTabs(): Promise<RawTab[]> {
    const res = await this.request("tab.list");
    return parseResult("tab.list", tabListResultSchema, res).tabs;
  }

  async listPanes(): Promise<RawPane[]> {
    const res = await this.request("pane.list");
    return parseResult("pane.list", paneListResultSchema, res).panes;
  }

  async exportLayout(tabId: string): Promise<TabLayout> {
    const res = await this.request("layout.export", { tab_id: tabId });
    return parseResult("layout.export", layoutExportResultSchema, res).layout;
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    opts: { dedicated?: boolean } = {},
  ): Promise<GenericResult> {
    if (opts.dedicated) {
      // Long-poll (agent.prompt --wait, agent.start, pane.wait_for_output) runs
      // on its own connection so it cannot stall the serialized request queue.
      const connection = new HerdrConnection(this.socketPath, this.log);
      await connection.connect();
      try {
        const res = await connection.request(method, params);
        return parseResult(method, genericResultSchema, res);
      } finally {
        connection.close();
      }
    }
    // Everything routed through call() is at-most-once: the callers are
    // mutating methods, and a request lost after the server acted on it must
    // not be silently re-issued.
    const res = await this.request(method, params, { noRetry: true });
    return parseResult(method, genericResultSchema, res);
  }

  async readPane(paneId: string, source: PaneReadSource, lines: number): Promise<PaneRead> {
    const res = await this.request("pane.read", { pane_id: paneId, source, lines });
    return parseResult("pane.read", paneReadResultSchema, res).read;
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.request("pane.send_text", { pane_id: paneId, text }, { noRetry: true });
  }

  /**
   * Stream agent-status changes for one pane over a dedicated connection.
   * Returns once the subscription is acknowledged by the server.
   */
  async subscribeAgentStatus(paneId: string, onEvent: (event: HerdrPush) => void): Promise<Subscription> {
    const connection = new HerdrConnection(this.socketPath, this.log);
    await connection.connect();
    connection.onPush = onEvent;
    try {
      await connection.request("events.subscribe", {
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }],
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    return { close: () => connection.close() };
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  private async ensureConnection(): Promise<HerdrConnection> {
    if (this.connection?.isOpen) return this.connection;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const connection = new HerdrConnection(this.socketPath, this.log);
      await connection.connect();
      connection.onClose = () => {
        this.log("herdr: request connection dropped; will reconnect on next request");
        if (this.connection === connection) this.connection = undefined;
      };
      this.connection = connection;
      return connection;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
}

export type { AgentStatus, RawAgent };
