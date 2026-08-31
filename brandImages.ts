import fs from "node:fs";
import path from "node:path";
import { getCategoriesSync } from "./dataReader";
import { getCategoryImage } from "./categoryImages";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]);
const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

/** Brand slugs are already canonical, but sanitize them before reading the filesystem. */
function safeBrandSlug(slug: string): string {
    return String(slug || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Returns the logo for a brand:
 * 1. Checks public/images/brands/<canonical-brand>/
 * 2. Checks public/images/categories/<canonical-brand>/
 * 3. Checks specific categorySlug if passed
 * 4. Finds any matching category in categories.json that has an image
 * 5. Checks public/images/categories for any folder matching or ending with -<canonical-brand>
 */
export function getBrandImage(brandSlug: string, categorySlug?: string): string {
    const safeSlug = safeBrandSlug(brandSlug);
    if (!safeSlug) return "";

    // 1. Check dedicated brands directory
    const brandFolder = path.join(process.cwd(), "public", "images", "brands", safeSlug);
    try {
        if (fs.existsSync(brandFolder)) {
            const image = fs.readdirSync(brandFolder)
                .filter(file => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
                .sort()[0];
            if (image) return `${BASE_URL}/images/brands/${safeSlug}/${encodeURIComponent(image)}`;
        }
    } catch {}

    // 2. If specific categorySlug provided, check it directly
    if (categorySlug) {
        const catImg = getCategoryImage(categorySlug);
        if (catImg) return catImg;
    }

    // 3. Check public/images/categories/<safeSlug> directly
    const directCatImg = getCategoryImage(safeSlug);
    if (directCatImg) return directCatImg;

    // 4. Search categories.json for any category matching this brand that has an image
    try {
        const categories = getCategoriesSync();
        for (const cat of Object.values(categories) as any[]) {
            if (!cat || !cat.slug) continue;
            const enName = safeBrandSlug(cat.i18n?.en?.name || cat.i18n?.tr?.name || cat.i18n?.ar?.name || "");
            const catSlugNorm = safeBrandSlug(cat.slug);
            if (enName === safeSlug || catSlugNorm === safeSlug || catSlugNorm.endsWith(`-${safeSlug}`)) {
                const img = getCategoryImage(cat.slug);
                if (img) return img;
            }
        }
    } catch {}

    // 5. Check public/images/categories for any folder matching or ending with -<safeSlug>
    try {
        const catRoot = path.join(process.cwd(), "public", "images", "categories");
        if (fs.existsSync(catRoot)) {
            const folders = fs.readdirSync(catRoot);
            for (const f of folders) {
                const fNorm = safeBrandSlug(f);
                if (fNorm === safeSlug || fNorm.endsWith(`-${safeSlug}`)) {
                    const img = getCategoryImage(f);
                    if (img) return img;
                }
            }
        }
    } catch {}

    return "";
}
