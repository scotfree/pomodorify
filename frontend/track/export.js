// Formatting logged totals for download. Pure; the download itself is in track.js.

// RFC 4180 style: quote a field if it contains a comma, quote or newline,
// doubling any quotes inside it.
function csvField(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// `project,hours` rows sorted by project name, hours to 2 decimals (for Excel).
export function totalsToCsv(totals) {
    const rows = Object.keys(totals)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .map(project => `${csvField(project)},${totals[project].toFixed(2)}`);
    return ['project,hours', ...rows].join('\r\n') + '\r\n';
}

// Full precision, so the JSON export works as a backup.
export function totalsToJson(totals) {
    return JSON.stringify(totals, null, 2) + '\n';
}

// "12.40 h across 3 projects" — used by the Clear confirmation.
export function describeTotals(totals) {
    const projects = Object.keys(totals).length;
    const hours = Object.values(totals).reduce((sum, h) => sum + h, 0);
    return `${hours.toFixed(2)} h across ${projects} project${projects === 1 ? '' : 's'}`;
}
