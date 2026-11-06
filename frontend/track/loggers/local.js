// Local totals logger: hours per project, kept in browser storage.
// Implements the Logger interface from DESIGN_V2.md.

const STORAGE_KEY = 'pomodorify_hours';

// `storage` is anything with getItem/setItem/removeItem. Tests pass a fake.
export function createLocalLogger(storage = globalThis.localStorage) {
    function read() {
        try {
            return JSON.parse(storage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    }

    return {
        name: 'local',

        addHours(project, hours) {
            const name = (project || '').trim();
            if (!name || !(hours > 0)) return;
            const totals = read();
            totals[name] = (totals[name] || 0) + hours;
            storage.setItem(STORAGE_KEY, JSON.stringify(totals));
        },

        getTotals() {
            return read();
        },

        clear() {
            storage.removeItem(STORAGE_KEY);
        },
    };
}
