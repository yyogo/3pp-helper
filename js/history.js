/**
 * Undo / redo history. Stack-of-snapshots: each entry is an opaque "snapshot"
 * value created by the caller (we never inspect it). On undo we restore the
 * top of the undo stack and move the current state onto the redo stack; redo
 * mirrors. Any new commit() clears the redo stack.
 *
 * `commit(snap)` is meant to be called with the state *as it was before the
 * action that just happened* — so undoing pops that "before" state.
 */
const MAX_ENTRIES = 100;
let undoStack = [];
let redoStack = [];

export function commit(snap) {
  if (snap == null) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  redoStack.length = 0;
}

export function undo(currentSnap, restore) {
  if (undoStack.length === 0) return false;
  const prev = undoStack.pop();
  redoStack.push(currentSnap);
  if (redoStack.length > MAX_ENTRIES) redoStack.shift();
  restore(prev);
  return true;
}

export function redo(currentSnap, restore) {
  if (redoStack.length === 0) return false;
  const next = redoStack.pop();
  undoStack.push(currentSnap);
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  restore(next);
  return true;
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}
