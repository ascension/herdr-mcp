import type { LayoutNode, RawAgent, RawPane, RawTab, RawWorkspace, TabLayout } from "./protocol.js";

/**
 * What Claude sees for each agent. Tool output is a prompt fragment: every
 * field must earn its place, and `agent_id` is the stable handle all other
 * tools accept as a target.
 */
export interface AgentView {
  /** Stable target handle (Herdr pane id, e.g. "w1:p1"). Pass to other tools. */
  agent_id: string;
  agent: string;
  status: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  focused: boolean;
}

export function shapeAgent(raw: RawAgent): AgentView {
  return {
    agent_id: raw.pane_id,
    agent: raw.agent,
    status: raw.agent_status,
    workspace_id: raw.workspace_id,
    tab_id: raw.tab_id,
    cwd: raw.cwd,
    focused: raw.focused,
  };
}

export interface WorkspaceView {
  workspace_id: string;
  label: string;
  focused: boolean;
  tab_count: number;
  pane_count: number;
  /** Aggregate status of agents in this workspace. */
  agent_status: string;
}

export function shapeWorkspace(raw: RawWorkspace): WorkspaceView {
  return {
    workspace_id: raw.workspace_id,
    label: raw.label,
    focused: raw.focused,
    tab_count: raw.tab_count,
    pane_count: raw.pane_count,
    agent_status: raw.agent_status,
  };
}

// ---- full layout tree (get_layout) ----

/** A pane leaf: role tells Claude whether typing here reaches an agent or a shell. */
export interface PaneNodeView {
  pane_id: string;
  role: "agent" | "shell";
  agent?: string;
  status?: string;
  cwd: string;
  focused: boolean;
}

export interface SplitNodeView {
  split: "left|right" | "top|bottom";
  ratio: number;
  first: LayoutNodeView;
  second: LayoutNodeView;
}

export type LayoutNodeView = PaneNodeView | SplitNodeView;

export interface TabView {
  tab_id: string;
  label: string;
  focused: boolean;
  zoomed: boolean;
  agent_status: string;
  layout: LayoutNodeView;
}

export interface WorkspaceLayoutView {
  workspace_id: string;
  label: string;
  focused: boolean;
  tabs: TabView[];
}

function shapeLayoutNode(node: LayoutNode, panesById: Map<string, RawPane>): LayoutNodeView {
  if (node.type === "split" && node.first && node.second) {
    return {
      split: node.direction === "right" ? "left|right" : "top|bottom",
      ratio: node.ratio ?? 0.5,
      first: shapeLayoutNode(node.first, panesById),
      second: shapeLayoutNode(node.second, panesById),
    };
  }
  const paneId = node.pane_id ?? "unknown";
  const pane = panesById.get(paneId);
  const view: PaneNodeView = {
    pane_id: paneId,
    role: pane?.agent ? "agent" : "shell",
    cwd: pane?.cwd ?? node.cwd ?? "",
    focused: pane?.focused ?? false,
  };
  if (pane?.agent) {
    view.agent = pane.agent;
    view.status = pane.agent_status;
  }
  return view;
}

/** Stitch workspace/tab/pane lists and per-tab layout exports into one tree. */
export function shapeFullLayout(
  workspaces: RawWorkspace[],
  tabs: RawTab[],
  panes: RawPane[],
  layoutsByTab: Map<string, TabLayout>,
): WorkspaceLayoutView[] {
  const panesById = new Map(panes.map((pane) => [pane.pane_id, pane]));
  return workspaces.map((workspace) => ({
    workspace_id: workspace.workspace_id,
    label: workspace.label,
    focused: workspace.focused,
    tabs: tabs
      .filter((tab) => tab.workspace_id === workspace.workspace_id)
      .map((tab) => {
        const layout = layoutsByTab.get(tab.tab_id);
        return {
          tab_id: tab.tab_id,
          label: tab.label,
          focused: tab.focused,
          zoomed: layout?.zoomed ?? false,
          agent_status: tab.agent_status,
          layout: layout
            ? shapeLayoutNode(layout.root, panesById)
            : { pane_id: "unknown", role: "shell" as const, cwd: "", focused: false },
        };
      }),
  }));
}
