// Most rows any read (REST GET or the list_entries tool) will return.
export const MAX_ROWS = 500;

// YYYY-MM-DD for N days ago, used by the `days` filter.
export const cutoffDate = (days) => new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
