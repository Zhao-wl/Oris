/**
 * 提交图泳道布局（R-HISTORY，任务 04 预制模块）。
 *
 * - 完全按提交的真实 parents（OID）计算连线，行号只决定显示位置，不参与拓扑推断；
 * - 输入须是拓扑顺序（子提交在父提交之前，与 `git log --topo-order` 一致），可以是分页累积的结果；
 * - 父提交尚未加载（分页边缘）或不在结果集中（筛选 / 搜索）时，对应泳道带“延续”标记，不伪造连线终点。
 */
export interface GraphCommit {
  oid: string;
  parents: string[];
}

export interface GraphEdge {
  /** 本行的泳道。 */
  fromLane: number;
  /** 下一行的泳道。 */
  toLane: number;
  /** 这条线最终要到达的父提交。 */
  target: string;
}

export interface GraphRow {
  oid: string;
  /** 本提交所在泳道。 */
  lane: number;
  /** 本行开始时各泳道正在等待的提交（null 表示空闲泳道）。 */
  lanesBefore: (string | null)[];
  /** 本行结束后各泳道等待的提交。 */
  lanesAfter: (string | null)[];
  /** 本行到下一行的连线（包括穿过本行的其他泳道）。 */
  edges: GraphEdge[];
  /** 汇入本提交的其他泳道（多个子提交分别占用泳道时，在此合并）。 */
  mergedLanes: number[];
  /** 本提交之上没有已加载的子提交（分支顶端或上一页之外）。 */
  isTip: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** 布局结束时仍在等待、但未出现在已加载提交中的父提交（分页边缘的延续）。 */
  continuations: { lane: number; target: string }[];
  width: number;
}

export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 0;
  const seen = new Set<string>();
  for (const commit of commits) {
    if (seen.has(commit.oid)) throw new Error(`提交重复：${commit.oid}`);
    seen.add(commit.oid);
    const lanesBefore = [...lanes];
    const waiting = lanes.flatMap((expected, index) => (expected === commit.oid ? [index] : []));
    let lane: number;
    const isTip = waiting.length === 0;
    if (isTip) {
      const free = lanes.indexOf(null);
      lane = free >= 0 ? free : lanes.length;
      if (free < 0) lanes.push(null);
    } else {
      lane = waiting[0];
    }
    const mergedLanes = waiting.slice(1);
    for (const merged of mergedLanes) lanes[merged] = null;
    const edges: GraphEdge[] = [];
    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;
    if (firstParent) edges.push({ fromLane: lane, toLane: lane, target: firstParent });
    for (const parent of otherParents) {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        edges.push({ fromLane: lane, toLane: existing, target: parent });
        continue;
      }
      const free = lanes.indexOf(null);
      const target = free >= 0 ? free : lanes.length;
      if (free < 0) lanes.push(parent);
      else lanes[free] = parent;
      edges.push({ fromLane: lane, toLane: target, target: parent });
    }
    // 穿过本行的其他泳道：原样延续到下一行。
    lanes.forEach((expected, index) => {
      if (expected && index !== lane && !edges.some((edge) => edge.toLane === index && edge.fromLane === lane)) {
        if (lanesBefore[index] === expected) edges.push({ fromLane: index, toLane: index, target: expected });
      }
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lanesBefore.length, lanes.length, lane + 1);
    rows.push({ oid: commit.oid, lane, lanesBefore, lanesAfter: [...lanes], edges, mergedLanes, isTip });
  }
  const continuations = lanes.flatMap((target, lane) => (target ? [{ lane, target }] : []));
  return { rows, continuations, width };
}
