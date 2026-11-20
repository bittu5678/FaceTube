export const DASHBOARD_FEATURED_CATEGORIES = ["Health", "Sports", "Drama"] as const;

export interface ApiCategoryRecord {
  id: string | number;
  name: string;
  slug: string;
  created_by?: string | undefined;
  created_at?: string | undefined;
}

export interface DashboardCategoryItem {
  id: string | number;
  name: string;
  slug: string;
  existsInDb: boolean;
  created_by?: string | undefined;
  created_at?: string | undefined;
}

export function toCategorySlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Merges live API/database categories with the three Dashboard categories
 * (Health, Sports, Drama) without creating duplicate entries.
 * Reuses database category records case-insensitively when present.
 */
export function buildDashboardCategoryCatalog(apiCategories: ApiCategoryRecord[]): {
  featured: DashboardCategoryItem[];
  existing: DashboardCategoryItem[];
  allUniqueNames: string[];
} {
  const byNormName = new Map<string, ApiCategoryRecord>();

  for (const cat of apiCategories) {
    const rawName = String(cat?.name || "").trim();
    if (!rawName) continue;
    const norm = rawName.toLowerCase();
    if (!byNormName.has(norm)) {
      byNormName.set(norm, {
        ...cat,
        name: rawName,
        slug: cat.slug || toCategorySlug(rawName),
      });
    }
  }

  const featuredSet = new Set<string>(
    DASHBOARD_FEATURED_CATEGORIES.map((name) => name.toLowerCase()),
  );

  const featured: DashboardCategoryItem[] = DASHBOARD_FEATURED_CATEGORIES.map((reqName) => {
    const existing = byNormName.get(reqName.toLowerCase());
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        slug: existing.slug,
        existsInDb: true,
        created_by: existing.created_by,
        created_at: existing.created_at,
      };
    }
    return {
      id: `dashboard-${toCategorySlug(reqName)}`,
      name: reqName,
      slug: toCategorySlug(reqName),
      existsInDb: false,
    };
  });

  const existing: DashboardCategoryItem[] = [];
  for (const [norm, cat] of byNormName.entries()) {
    if (featuredSet.has(norm)) continue;
    existing.push({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      existsInDb: true,
      created_by: cat.created_by,
      created_at: cat.created_at,
    });
  }

  const allUniqueNames = [...featured.map((c) => c.name), ...existing.map((c) => c.name)];

  return { featured, existing, allUniqueNames };
}
