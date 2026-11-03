// The parts of a cost total that the Cost page's cards and columns (CPU, memory, storage, network) do not show: GPU
// and load balancers, so the shown amounts and these add up to the total. Not a difference of the total and its parts:
// OpenCost rounds each amount to five decimals, so that difference is rounding (±0.00001 a row), not a cost.
export interface CostAmounts {
  gpu_cost: number
  load_balancer_cost: number
}

export interface CostOutside {
  gpu: number
  loadBalancers: number
}

export function costOutsideCards(t: CostAmounts): CostOutside {
  return { gpu: t.gpu_cost, loadBalancers: t.load_balancer_cost }
}

export const hasCostOutside = (o: CostOutside) => o.gpu !== 0 || o.loadBalancers !== 0
