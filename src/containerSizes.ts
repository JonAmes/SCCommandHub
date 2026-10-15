export const CONTAINER_SIZES = [1, 2, 4, 8, 16, 32] as const

export function getContainerSelection(quantity: number) {
  const wholeScu = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0
  const size = [...CONTAINER_SIZES].reverse().find((candidate) => wholeScu >= candidate && wholeScu % candidate === 0) ?? 1
  return { size, count: wholeScu / size }
}

export function isContainerSizedQuantity(quantity: number) {
  return Number.isFinite(quantity) && quantity > 0 && Number.isInteger(quantity)
}