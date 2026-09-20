import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return text;
};

// start_agent without pane_id: split + launch in one call.
const started = JSON.parse(
  await call("start_agent", { kind: "pi", cwd: "/tmp", name: `live-smoke-${Date.now().toString(36)}` }),
);
const paneId = started.agent?.pane_id;
console.log("started:", paneId, "argv:", started.argv);

await call("wait_for_agent_status", { agent_id: paneId, until: ["idle"], timeout_seconds: 60 });
console.log("idle");

const promptRes = await call("send_to_agent", {
  agent_id: paneId,
  text: "Reply with exactly LIVE-SMOKE-OK and nothing else.",
  submit: true,
  wait_seconds: 120,
});
console.log("prompt done");

const out = await call("read_pane", { pane_id: paneId, source: "recent", lines: 40 });
console.log("token seen:", out.includes("LIVE-SMOKE-OK"));

// send_to_agent submit path already used agent.prompt; now close via raw rpc.
await call("herdr_rpc", { method: "pane.close", params: { pane_id: paneId } });
console.log("closed");

await client.close();
