// Splitting and ordering the user's playlists. Pure.

export const SAVED_PREFIX = 'POMO_';

// Saved sessions (POMO_ playlists, made by SAVE) are replayable; everything
// else is a source for building new sessions.
export function partitionPlaylists(playlists) {
    const sources = [];
    const saved = [];
    for (const p of playlists) {
        (p.name.startsWith(SAVED_PREFIX) ? saved : sources).push(p);
    }
    return { sources, saved };
}

// Random order the first time, then stable: playlists already in `storedOrder`
// keep their relative order, deleted ones drop out, and new ones are inserted
// at random positions. Starting from an empty stored order this is a uniform
// shuffle. Returns { ordered, order } where `order` (ids) is what to store.
export function orderReplays(saved, storedOrder = [], random = Math.random) {
    const byId = new Map(saved.map(p => [p.id, p]));
    const known = new Set();
    const order = storedOrder.filter(id => byId.has(id) && !known.has(id) && known.add(id));
    for (const p of saved) {
        if (known.has(p.id)) continue;
        order.splice(Math.floor(random() * (order.length + 1)), 0, p.id);
        known.add(p.id);
    }
    return { ordered: order.map(id => byId.get(id)), order };
}
