export function fuzzyMatch(query: string, text: string): number {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length === 0) return 1;
	if (t.includes(q)) return 2 + q.length / t.length;

	let qi = 0;
	let score = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += 1;
			qi++;
		}
	}
	return qi === q.length ? score / t.length : 0;
}

export function fuzzyMatchFile(query: string, relativePath: string): number {
	if (query.length === 0) return 1;
	const slash = relativePath.lastIndexOf("/");
	const basename = slash === -1 ? relativePath : relativePath.slice(slash + 1);
	const pathScore = fuzzyMatch(query, relativePath);
	const baseScore = fuzzyMatch(query, basename);
	return Math.max(baseScore * 1.5, pathScore);
}
