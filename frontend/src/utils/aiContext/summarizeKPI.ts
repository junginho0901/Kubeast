/**
 * KPI 대시보드 요약 (GPU / 기타 측정지표 대시보드).
 *
 * - `cluster_gpu`: 원본 KPI 블록 (이미 집계된 값이므로 그대로 유지)
 * - `nodes`: `nodePickFields` 로 slim
 * - `top_consumers`: 상한 N 개만
 */

export interface SummarizeKPIOptions<Node, Consumer> {
  nodePickFields?: Array<keyof Node>
  consumerPickFields?: Array<keyof Consumer>
  topN: { nodes: number; consumers: number }
}

export interface KPIInput<Node, Consumer> {
  cluster_gpu: Record<string, unknown>
  nodes: Node[]
  top_consumers: Consumer[]
  time_range?: { from: string; to: string }
}

export interface KPISummary<Node, Consumer> {
  cluster_gpu: Record<string, unknown>
  nodes: Array<Partial<Node>>
  top_consumers: Array<Partial<Consumer>>
  time_range?: { from: string; to: string }
}

export function summarizeKPI<
  Node extends Record<string, unknown>,
  Consumer extends Record<string, unknown>,
>(
  input: KPIInput<Node, Consumer>,
  options: SummarizeKPIOptions<Node, Consumer>,
): KPISummary<Node, Consumer> {
  const slimNode = (n: Node): Partial<Node> => {
    if (!options.nodePickFields) return { ...n }
    return options.nodePickFields.reduce<Partial<Node>>((acc, f) => {
      acc[f] = n[f]
      return acc
    }, {})
  }
  const slimConsumer = (c: Consumer): Partial<Consumer> => {
    if (!options.consumerPickFields) return { ...c }
    return options.consumerPickFields.reduce<Partial<Consumer>>((acc, f) => {
      acc[f] = c[f]
      return acc
    }, {})
  }

  return {
    cluster_gpu: input.cluster_gpu,
    nodes: input.nodes.slice(0, options.topN.nodes).map(slimNode),
    top_consumers: input.top_consumers
      .slice(0, options.topN.consumers)
      .map(slimConsumer),
    time_range: input.time_range,
  }
}
