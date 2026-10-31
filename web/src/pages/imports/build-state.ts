/**
 * The build-playlist page's form state, kept in localStorage so a reload, a crash, or the backend
 * going away cannot lose a half-made selection. One key per import (`plst.build.<id>`), so
 * building two imports never mixes their ticks, and a page left open in another tab stays
 * independent.
 *
 * Both fields are nullable on purpose: `null` means "untouched", which is not the same as
 * "empty". An untouched name uses the generated suggestion; an untouched selection is the NEW
 * tracks — what the backend itself would do with an empty form.
 */
export interface BuildState {
  name: string | null;
  selected: number[] | null;
  savedAt: number;
}

const key = (importId: number): string => `plst.build.${importId}`;

export function loadBuildState(importId: number): BuildState | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(importId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuildState>;
    // Shape-checked: a hand-edited or half-written value must degrade to "untouched", never to a
    // page that throws on render.
    if (typeof parsed !== 'object' || parsed === null) return null;
    const name = typeof parsed.name === 'string' ? parsed.name : null;
    const selected =
      Array.isArray(parsed.selected) && parsed.selected.every((n) => Number.isInteger(n))
        ? (parsed.selected as number[])
        : null;
    return { name, selected, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    // localStorage throws on opaque origins and JSON.parse throws on garbage — both mean
    // "no saved state", not "broken page".
    return null;
  }
}

export function saveBuildState(importId: number, state: BuildState): void {
  try {
    globalThis.localStorage?.setItem(key(importId), JSON.stringify(state));
  } catch {
    /* quota or opaque origin: the page still works, it just cannot remember */
  }
}

export function clearBuildState(importId: number): void {
  try {
    globalThis.localStorage?.removeItem(key(importId));
  } catch {
    /* see above */
  }
}
