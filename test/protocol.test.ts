import { describe, expect, it } from "vitest";
import {
  agentListResultSchema,
  HerdrError,
  isHerdrPush,
  isHerdrResponse,
  parseResult,
  pushType,
} from "../src/protocol.js";

describe("isHerdrResponse", () => {
  it("accepts a success response", () => {
    expect(isHerdrResponse({ id: "req_1", result: { type: "pong" } })).toBe(true);
  });

  it("accepts an error response", () => {
    expect(isHerdrResponse({ id: "1", error: { code: "pane_not_found", message: "nope" } })).toBe(true);
  });

  it("rejects a malformed error payload", () => {
    expect(isHerdrResponse({ id: "1", error: "boom" })).toBe(false);
  });

  it("rejects lines without a string id", () => {
    expect(isHerdrResponse({ type: "event" })).toBe(false);
    expect(isHerdrResponse({ id: 4 })).toBe(false);
    expect(isHerdrResponse(null)).toBe(false);
    expect(isHerdrResponse("hello")).toBe(false);
  });
});

describe("isHerdrPush", () => {
  it("accepts objects with a string type", () => {
    expect(isHerdrPush({ type: "pane.agent_status_changed", pane_id: "w1:p1" })).toBe(true);
  });

  it("accepts protocol-22 {event, data} pushes", () => {
    expect(
      isHerdrPush({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1" } }),
    ).toBe(true);
  });

  it("does not classify a response carrying an event field as a push", () => {
    const line = { id: "req_1", result: { type: "ok" }, event: "x" };
    expect(isHerdrResponse(line)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isHerdrPush({ id: "1" })).toBe(false);
    expect(isHerdrPush([])).toBe(false);
    expect(isHerdrPush(undefined)).toBe(false);
  });
});

describe("pushType", () => {
  it("reads type and normalizes event", () => {
    expect(pushType({ type: "pane.closed" })).toBe("pane.closed");
    expect(pushType({ event: "pane.closed", data: {} })).toBe("pane.closed");
  });
});

describe("parseResult", () => {
  const validAgent = {
    terminal_id: "term_1",
    agent: "claude",
    agent_status: "working",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: true,
    cwd: "/tmp",
    foreground_cwd: "/tmp",
  };

  it("returns the typed payload on success", () => {
    const result = parseResult("agent.list", agentListResultSchema, {
      type: "agent_list",
      agents: [validAgent],
    });
    expect(result.agents[0]?.pane_id).toBe("w1:p1");
  });

  it("tolerates extra fields (forward compatibility)", () => {
    const result = parseResult("agent.list", agentListResultSchema, {
      type: "agent_list",
      agents: [{ ...validAgent, revision: 7, new_field: "x" }],
    });
    expect(result.agents).toHaveLength(1);
  });

  it("throws a HerdrError naming the method on shape drift", () => {
    expect(() => parseResult("agent.list", agentListResultSchema, { type: "wrong" })).toThrow(HerdrError);
    expect(() => parseResult("agent.list", agentListResultSchema, { type: "wrong" })).toThrow(/agent\.list/);
  });
});
