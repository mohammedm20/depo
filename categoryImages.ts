/**
 * Category Images Utility
 * Dynamically discovers images from the file system instead of relying on JSON
 */

import fs from 'fs';
import path from 'path';
import { formatUrlSlug } from './urlFormatter';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];

// Base URL for Astro (dynamic)
const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Get all images for a category from its folder
 * @param slug - The category slug (folder name)
 * @returns Array of image paths relative to public folder
 * @example getCategoryImages('PLC > Siemens') -> looks in public/images/categories/plc-siemens
 */
export function getCategoryImages(slug: string): string[] {
    if (!slug) return [];

    // Sanitize slug for file system consistently
    const safeSlug = formatUrlSlug(slug);
    const catRoot = path.join(process.cwd(), 'public', 'images', 'categories');
    if (!fs.existsSync(catRoot)) return [];

    let categoryDir = path.join(catRoot, safeSlug);
    let resolvedSlug = safeSlug;

    if (!fs.existsSync(categoryDir)) {
        const rawDir = path.join(catRoot, slug);
        if (fs.existsSync(rawDir)) {
            categoryDir = rawDir;
            resolvedSlug = slug;
        } else {
            try {
                const entries = fs.readdirSync(catRoot);
                const match = entries.find(e => formatUrlSlug(e) === safeSlug || e.toLowerCase() === slug.toLowerCase());
                if (match) {
                    categoryDir = path.join(catRoot, match);
                    resolvedSlug = match;
                } else {
                    return [];
                }
            } catch {
                return [];
            }
        }
    }

    try {
        const files = fs.readdirSync(categoryDir);

        // Filter only image files
        const images = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return IMAGE_EXTENSIONS.includes(ext);
        });

        // Return full paths with base URL for Astro
        return images.map(img => `${BASE_URL}/images/categories/${encodeURIComponent(resolvedSlug)}/${encodeURIComponent(img)}`);
    } catch (error) {
        console.error(`Error reading category images for ${slug}:`, error);
        return [];
    }
}

/**
 * Get the primary (first) image for a category
 * Falls back to default image if none found
 * @param slug - The category slug
 * @param defaultImage - Optional default image path
 * @returns Image path or default
 */
export function getCategoryImage(slug: string, defaultImage: string = ''): string {
    const images = getCategoryImages(slug);
    return images.length > 0 ? images[0] : defaultImage;
}

/**
 * Check if a category has any images
 * @param slug - The category slug
 * @returns boolean
 */
export function categoryHasImage(slug: string): boolean {
    return getCategoryImages(slug).length > 0;
}
