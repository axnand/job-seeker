/** Build the cross-source dedup key. */
export function dedupeKey(company: string, role: string, location?: string): string {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  return `${norm(company)}::${norm(role)}::${norm(location ?? "")}`;
}
