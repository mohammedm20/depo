
// Works with both a custom domain (/) and GitHub Pages subpaths (/home).
const BASE_URL = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export interface SearchItem {
    type: 'product' | 'category';
    id: string;
    title_tr: string;
    title_en: string;
    title_ar: string;
    image: string;
    categorySlug?: string;
    brand?: string;
    brandSearch?: string;
    inStock?: boolean;
    price?: string | number;
    parentSlug?: string;
}

export interface SearchFilters {
    q: string;
    brand: string[];
    inStock: boolean;
    contactPrice: boolean;
    minPrice: number;
    maxPrice: number;
}

export class SearchEngine {
    private static instance: SearchEngine;
    private index: SearchItem[] = [];
    private isLoaded = false;
    private currentLang: string = 'tr';

    private constructor() {
        if (typeof document !== 'undefined') {
            this.currentLang = document.documentElement.lang || 'tr';
        }
    }

    public static getInstance(): SearchEngine {
        if (!SearchEngine.instance) {
            SearchEngine.instance = new SearchEngine();
        }
        return SearchEngine.instance;
    }

    public async init() {
        if (this.isLoaded) return;
        try {
            const res = await fetch(`${BASE_URL}/api/search-index.json`);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            this.index = await res.json();
            this.isLoaded = true;
        } catch (err) {
            console.error("SearchEngine init error:", err);
        }
    }

    public getIsLoaded() {
        return this.isLoaded;
    }

    public search(filters: SearchFilters) {
        const query = filters.q.toLowerCase().trim();

        const filteredProducts = this.index.filter(item => {
            if (item.type !== 'product') return false;

            // Text search
            if (query) {
                const searchContent = `${item.id} ${item.title_tr} ${item.title_en} ${item.title_ar} ${item.brandSearch || ''}`.toLowerCase();
                if (!searchContent.includes(query)) return false;
            }

            // Brand filter
            if (filters.brand.length > 0) {
                const normFilters = filters.brand.map(b => b.toLowerCase().trim());
                const itemBrandNorm = (item.brand || '').toLowerCase().trim();
                if (!itemBrandNorm || !normFilters.includes(itemBrandNorm)) {
                    return false;
                }
            }

            // Stock filter
            if (filters.inStock && item.inStock === false) return false;

            // Price filter
            const isContact = item.price === 'contact' || item.price === '0' || item.price === 0 || isNaN(Number(item.price));
            if (filters.contactPrice) {
                if (!isContact) return false;
            } else {
                if (isContact && (filters.minPrice > 0 || filters.maxPrice < Infinity)) return false;
                const price = Number(item.price) || 0;
                if (price < filters.minPrice || (filters.maxPrice < Infinity && price > filters.maxPrice)) return false;
            }

            return true;
        });

        const filteredCategories = this.index.filter(item => {
            if (item.type !== 'category') return false;
            if (!query) return false; // Usually don't show categories unless there's a query

            const searchContent = `${item.id} ${item.title_tr} ${item.title_en} ${item.title_ar}`.toLowerCase();
            return searchContent.includes(query);
        });

        return {
            products: filteredProducts,
            categories: filteredCategories
        };
    }

    public getFacetedCounts(filters: Omit<SearchFilters, 'brand'>) {
        const query = filters.q.toLowerCase().trim();
        const counts: Record<string, number> = {};

        this.index.forEach(item => {
            if (item.type !== 'product' || !item.brand) return;

            // Would this item be visible if we ignored the brand filter?
            let wouldBeVisible = true;

            if (query) {
                const searchContent = `${item.id} ${item.title_tr} ${item.title_en} ${item.title_ar} ${item.brandSearch || ''}`.toLowerCase();
                if (!searchContent.includes(query)) wouldBeVisible = false;
            }

            if (filters.inStock && item.inStock === false) wouldBeVisible = false;

            const isContact = item.price === 'contact' || item.price === '0' || item.price === 0 || isNaN(Number(item.price));
            if (filters.contactPrice) {
                if (!isContact) wouldBeVisible = false;
            } else {
                if (isContact && (filters.minPrice > 0 || filters.maxPrice < Infinity)) wouldBeVisible = false;
                const price = Number(item.price) || 0;
                if (price < filters.minPrice || (filters.maxPrice < Infinity && price > filters.maxPrice)) wouldBeVisible = false;
            }

            if (wouldBeVisible) {
                counts[item.brand] = (counts[item.brand] || 0) + 1;
            }
        });

        return counts;
    }
}
