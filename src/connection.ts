import net from "node:net";
import readline from "node:readline";
import { HerdrError, type HerdrPush, isHerdrPush, isHerdrResponse } from "./protocol.js";

export type Logger = (message: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A single connection to the Herdr socket: NDJSON framing, request/response
 * correlation by id, and a hook for server-pushed lines (events).
 *
 * Lifecycle is deliberately simple: connect once, use, close. Reconnect
 * policy lives in HerdrClient, which creates a fresh connection on demand.
 */
export class HerdrConnection {
  private readonly pending = new Map<string, Pending>();
  private socket: net.Socket | undefined;
  private nextId = 1;
  private closed = false;

  onPush: ((push: HerdrPush) => void) | undefined;
  onClose: (() => void) | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly log: Logger,
  ) {}

  get isOpen(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });

      socket.once("connect", () => {
        this.socket = socket;
        socket.on("error", (err) => this.teardown(new Error(`socket error: ${err.message}`)));
        socket.on("close", () => this.teardown(new Error("socket closed")));

        const rl = readline.createInterface({ input: socket });
        rl.on("line", (line) => this.handleLine(line));
        // readline re-emits input-stream errors; without a listener they
        // crash the process. The socket's own error handler does the teardown.
        rl.on("error", () => {});
        resolve();
      });

      socket.once("error", (err) => {
        reject(new Error(`cannot connect to Herdr at ${this.socketPath}: ${err.message}`));
      });
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (!socket || this.closed) {
      throw new Error("connection is not open");
    }
    const id = `req_${this.nextId++}`;
    const line = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // A write error (e.g. EPIPE on a half-closed socket) must reject this
      // request; the socket's error event then tears down the rest.
      socket.write(`${line}\n`, (error) => {
        if (error && this.pending.delete(id)) reject(error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`herdr: dropping non-JSON line: ${line.slice(0, 200)}`);
      return;
    }

    if (isHerdrResponse(msg)) {
      // Herdr answers requests it could not parse with an empty id. Requests
      // are serialized (one in flight per connection), so attribute such an
      // error to the sole pending request instead of dropping it — otherwise
      // the caller only ever sees "socket closed".
      let key = msg.id;
      if (!this.pending.has(key) && key === "" && msg.error && this.pending.size === 1) {
        key = this.pending.keys().next().value as string;
      }
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        if (msg.error) {
          pending.reject(new HerdrError(msg.error.code, msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
    }

    // Not a reply to anything we sent — treat it as a server push (event).
    if (isHerdrPush(msg)) {
      this.onPush?.(msg);
    } else {
      this.log(`herdr: dropping unrecognized line: ${line.slice(0, 200)}`);
    }
  }

  private teardown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = undefined;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.onClose?.();
  }
}
