import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { HerdrRequest } from "../src/protocol.js";

export type RequestHandler = (request: HerdrRequest, reply: (line: object) => void) => void;

/**
 * A minimal NDJSON Unix-socket server that mimics Herdr for tests: the test
 * supplies the per-request behavior, including delayed / out-of-order replies
 * and unsolicited pushes.
 */
export class FakeHerdrServer {
  readonly socketPath: string;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly onRequest: RequestHandler) {
    this.socketPath = path.join(
      os.tmpdir(),
      `fake-herdr-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      const rl = readline.createInterface({ input: socket });
      rl.on("line", (line) => {
        const request = JSON.parse(line) as HerdrRequest;
        this.onRequest(request, (reply) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        });
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  /** Push a line to every connected client (simulates an event). */
  push(payload: object): void {
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    }
  }

  /** Abruptly drop all client connections (simulates a server restart). */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  close(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
