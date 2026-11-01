type ScreenshotOrderedItem = { id: string; order: number }
type ScreenshotOrderedAction = ScreenshotOrderedItem & { kind: string }

export function orderedScreenshotToolbarIds(
  items: readonly ScreenshotOrderedItem[],
  actions: readonly ScreenshotOrderedAction[],
  screenshotOrder: readonly string[]
): string[] {
  const fallback = [
    ...[...items].sort((left, right) => left.order - right.order).map((item) => item.id),
    ...actions
      .filter((action) => action.kind === 'extract')
      .sort((left, right) => left.order - right.order)
      .map((action) => action.id)
  ]
  const valid = new Set(fallback)
  const seen = new Set<string>()
  const ordered: string[] = []

  // Saved order takes priority; new items are appended and stale references drop out.
  for (const id of [...screenshotOrder, ...fallback]) {
    if (!valid.has(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

export function reorderScreenshotToolbarOrder(
  screenshotOrder: readonly string[],
  activeId: string,
  overId: string
): string[] {
  const ordered = [...screenshotOrder]
  const activeIndex = ordered.indexOf(activeId)
  const overIndex = ordered.indexOf(overId)
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return ordered

  const [moving] = ordered.splice(activeIndex, 1)
  ordered.splice(overIndex, 0, moving!)
  return ordered
}
