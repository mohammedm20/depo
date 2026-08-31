const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// --- GLOBAL CACHE FOR IMAGE DISCOVERY ---
let cachedImageMap = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// --- CACHING HELPERS ---
function getImageMap() {
    const now = Date.now();
    if (cachedImageMap && (now - lastCacheUpdate < CACHE_TTL)) {
        return cachedImageMap;
    }

    const imagesBaseDir = path.join(__dirname, 'public', 'images', 'products');
    const imageMap = {};

    if (fs.existsSync(imagesBaseDir)) {
        try {
            const folders = fs.readdirSync(imagesBaseDir);
            folders.forEach(folder => {
                const folderPath = path.join(imagesBaseDir, folder);
                if (fs.lstatSync(folderPath).isDirectory()) {
                    const files = fs.readdirSync(folderPath).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
                    if (files.length > 0) {
                        const safeFolder = sanitizeProductId(folder);
                        imageMap[safeFolder] = `/images/products/${folder}/${encodeURIComponent(files[0])}`;
                    }
                }
            });
            cachedImageMap = imageMap;
            lastCacheUpdate = now;
        } catch (e) {
            console.error("Error refreshing image map:", e);
            return cachedImageMap || {};
        }
    }
    return imageMap;
}

// Helper to invalidate cache
function invalidateImageCache() {
    cachedImageMap = null;
    lastCacheUpdate = 0;
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// File paths - ONLY src/data directory (single source of truth)
const dataDir = path.join(__dirname, 'src', 'data');
const productsFile = path.join(dataDir, 'products.json');
const categoriesFile = path.join(dataDir, 'categories.json');
const pricelistsFile = path.join(dataDir, 'pricelists.json');
const siteFile = path.join(dataDir, 'site.json');

// Backup file paths (stored in src/data as well)
const productsBackupFile = path.join(dataDir, 'products.backup.json');

const categoriesBackupFile = path.join(dataDir, 'categories.backup.json');
const pricelistsBackupFile = path.join(dataDir, 'pricelists.backup.json');

// Global status for image optimization
let imageOptimizationStatus = {
    running: false,
    scanned: 0,
    total: 0,
    optimized: 0,
    skipped: 0,
    errors: 0,
    currentFile: '',
    message: ''
};

// --- Sanitization Helpers ---
const sanitizeProductId = (id) => {
    if (!id) return '';
    return String(id).trim()
             .replace(/\s+/g, '-') // Replace spaces with hyphens
             .replace(/[<>:"\/\\|?*]/g, '-') // Replace invalid filename/path chars
             .toLowerCase();
};

const sanitizeFilename = (filename) => {
    if (!filename) return '';
    // Strip path traversal sequences and keep only safe characters
    const ext = path.extname(filename);
    const namePart = path.basename(filename, ext);
    const safeName = namePart.replace(/[^a-zA-Z0-9-_]/g, '_');
    return (safeName + ext).toLowerCase();
};

const canonicalBrandSlug = (name) => String(name || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Security Helper: Validate that a path is within a specific base directory
const isPathSafe = (baseDir, targetPath) => {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget.startsWith(resolvedBase);
};

// Create JSON files if they don't exist
const ensureFile = (filePath, defaultContent = '{}') => {
    if (!fs.existsSync(filePath)) {
        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(filePath, defaultContent, 'utf8');
        console.log(`✅ Created empty ${path.basename(filePath)}`);
    }
};

// --- Image Optimization Helper ---
async function optimizeImage(inputBuffer, outputPath) {
    try {
        const image = sharp(inputBuffer);
        const metadata = await image.metadata();

        let pipeline = image;

        // Resize if width or height > 1200
        if (metadata.width > 1200 || metadata.height > 1200) {
            pipeline = pipeline.resize(1200, 1200, {
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        // Compress based on format
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            pipeline = pipeline.jpeg({ 
                quality: 75,
                mozjpeg: true,
                chromaSubsampling: '4:2:0'
            });
        } else if (metadata.format === 'png') {
            pipeline = pipeline.png({ 
                quality: 75, 
                compressionLevel: 9,
                palette: true 
            });
        } else if (metadata.format === 'webp') {
            pipeline = pipeline.webp({ 
                quality: 75,
                effort: 6 
            });
        }

        await pipeline.toFile(outputPath);
        return true;
    } catch (err) {
        console.error(`❌ Optimization error for ${outputPath}:`, err);
        // Fallback: write original buffer if optimization fails
        fs.writeFileSync(outputPath, inputBuffer);
        return false;
    }
}

// Ensure data directory and files exist
if (!fs.existsSync(categoriesFile) && fs.existsSync(categoriesBackupFile)) {
    fs.copyFileSync(categoriesBackupFile, categoriesFile);
    console.log('✅ Restored categories.json from backup');
}
if (!fs.existsSync(productsFile) && fs.existsSync(productsBackupFile)) {
    fs.copyFileSync(productsBackupFile, productsFile);
    console.log('✅ Restored products.json from backup');
}
ensureFile(pricelistsFile);
ensureFile(siteFile, JSON.stringify({
    seo: { title: "OB Simatic", description: "" },
    contact: {},
    about: {},
    social: {}
}, null, 4));

// --- API Endpoints ---

app.post('/api/validate-path', (req, res) => {
    const { value } = req.body;
    if (!value) return res.status(400).json({ valid: false, error: 'Value is required' });

    // Git/Windows safe characters: Alphanumeric, hyphen, underscore, period
    // No spaces, no Arabic characters, no restricted symbols
    // Relaxed check for storage ID: Allow Alphanumeric, hyphen, underscore, period, and slash.
    // We also allow uppercase as it will be sanitized later for FS/URLs.
    const storageIdRegex = /^[a-zA-Z0-9._-\s\/]+$/;
    
    if (storageIdRegex.test(value)) {
        res.json({ valid: true });
    } else {
        res.json({ 
            valid: false, 
            error: 'ID contains invalid characters. Use English letters, numbers, hyphens, underscores, or slashes only.' 
        });
    }
});

// GET /api/products - Read products.json
app.get('/api/products', (req, res) => {
    try {
        const data = fs.readFileSync(productsFile, 'utf8');
        const products = JSON.parse(data);

        // --- OPTIONAL: Inject Primary Image info for Admin Panel ---
        const imageMap = getImageMap();
        
        Object.keys(products).forEach(id => {
            const safeId = sanitizeProductId(id);
            if (imageMap[safeId]) {
                products[id].image = imageMap[safeId];
            }
        });

        res.json(products);
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.json({});
        } else {
            res.status(500).json({ error: 'Failed to read products.json: ' + err.message });
        }
    }
});

// POST /api/products - Write products.json
app.post('/api/products', (req, res) => {
    try {
        const data = JSON.stringify(req.body, null, 4);
        // Write to src/data (single source of truth)
        fs.writeFileSync(productsFile, data, 'utf8');

        // --- Image Folder Creation Logic ---
        // Create folder for each product in public/images/products
        const imagesBaseDir = path.join(__dirname, 'public', 'images', 'products');

        // Ensure base images directory exists
        if (!fs.existsSync(imagesBaseDir)) {
            fs.mkdirSync(imagesBaseDir, { recursive: true });
        }

        // Create folder for each product ID & track active IDs for cleanup
        const products = req.body;
        const activeSafeIds = new Set();
        let createdCount = 0;

        Object.keys(products).forEach(id => {
            if (id && id.trim() !== '') {
                const safeId = sanitizeProductId(id);
                activeSafeIds.add(safeId);
                const productImgDir = path.join(imagesBaseDir, safeId);
                if (!fs.existsSync(productImgDir)) {
                    fs.mkdirSync(productImgDir, { recursive: true });
                    createdCount++;
                }
            }
        });

        // --- Cleanup Orphaned Folders ---
        if (fs.existsSync(imagesBaseDir)) {
            const folders = fs.readdirSync(imagesBaseDir);
            folders.forEach(folder => {
                const folderPath = path.join(imagesBaseDir, folder);
                // Use sanitized name for comparison to handle Windows case-insensitivity and formatting
                const safeFolder = sanitizeProductId(folder);
                if (fs.lstatSync(folderPath).isDirectory() && !activeSafeIds.has(safeFolder)) {
                    try {
                        fs.rmSync(folderPath, { recursive: true, force: true });
                        console.log('🗑️ Deleted orphaned product folder:', folderPath);
                    } catch (e) {
                        console.error('Failed to delete orphaned product folder:', folderPath, e);
                    }
                }
            });
        }

        invalidateImageCache();
        res.json({
            success: true,
            message: 'Products saved successfully',
            foldersCreated: createdCount
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write products.json: ' + err.message });
    }
});

// GET /api/categories - Read categories.json
app.get('/api/categories', (req, res) => {
    try {
        const data = fs.readFileSync(categoriesFile, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.json({});
        } else {
            res.status(500).json({ error: 'Failed to read categories.json' });
        }
    }
});

// POST /api/categories - Write categories.json
app.post('/api/categories', (req, res) => {
    try {
        const categoriesData = req.body;
        const data = JSON.stringify(categoriesData, null, 4);

        // Write to src/data (single source of truth)
        fs.writeFileSync(categoriesFile, data, 'utf8');

        // --- PROACTIVE BRAND IMAGE SYNC ---
        // If a Level 2 category (Brand) is created or modified, ensure it has images 
        // if another category with the same brand name has them.
        try {
            const publicCategoriesDir = path.join(__dirname, 'public', 'images', 'categories');
            if (fs.existsSync(publicCategoriesDir)) {
                // 1. Group brand name (case-insensitive) -> Array of slugs
                const brandGroups = {};
                Object.values(categoriesData).forEach(cat => {
                    // Check if Level 2: has parent, and parent has no parent
                    if (cat.parentSlug && categoriesData[cat.parentSlug] && !categoriesData[cat.parentSlug].parentSlug) {
                        const name = (cat.i18n?.en?.name || cat.i18n?.tr?.name || cat.i18n?.ar?.name || '').trim().toLowerCase();
                        if (name) {
                            if (!brandGroups[name]) brandGroups[name] = [];
                            brandGroups[name].push(cat.slug.replace(/[<>:"\/\\|?*]/g, '-').toLowerCase());
                        }
                    }
                });

                // 2. For each brand group, find the one with the most images and sync to others
                Object.keys(brandGroups).forEach(brandName => {
                    const slugs = brandGroups[brandName];
                    if (slugs.length < 2) return; // Nothing to sync

                    // Find a "source" slug that actually has a folder with images
                    let sourceSlug = null;
                    let sourceFiles = [];

                    for (const slug of slugs) {
                        const dir = path.join(publicCategoriesDir, slug);
                        if (fs.existsSync(dir)) {
                            const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
                            if (files.length > sourceFiles.length) {
                                sourceFiles = files;
                                sourceSlug = slug;
                            }
                        }
                    }

                    if (sourceSlug && sourceFiles.length > 0) {
                        const sourceDir = path.join(publicCategoriesDir, sourceSlug);
                        slugs.forEach(targetSlug => {
                            if (targetSlug === sourceSlug) return;
                            const targetDir = path.join(publicCategoriesDir, targetSlug);
                            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                            sourceFiles.forEach(file => {
                                const targetFilePath = path.join(targetDir, file);
                                if (!fs.existsSync(targetFilePath)) {
                                    fs.copyFileSync(path.join(sourceDir, file), targetFilePath);
                                    console.log(`📡 [Proactive Sync] Copied ${file} from ${sourceSlug} to ${targetSlug}`);
                                }
                            });
                        });
                    }
                });
            }
        } catch (syncErr) {
            console.error('⚠️ [Proactive Sync] Error:', syncErr);
        }

        res.json({ success: true, message: 'Categories saved successfully (and synced brands)' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write categories.json: ' + err.message });
    }
});

// GET /api/pricelists - Read pricelists.json
app.get('/api/pricelists', (req, res) => {
    try {
        if (!fs.existsSync(pricelistsFile)) {
            // Create it (ensure directory exists first)
            const dir = path.dirname(pricelistsFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(pricelistsFile, '[]', 'utf8'); // Default empty array
            return res.json([]);
        }

        const data = fs.readFileSync(pricelistsFile, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.json([]);
        } else {
            res.status(500).json({ error: 'Failed to read pricelists.json: ' + err.message });
        }
    }
});

// POST /api/pricelists - Write pricelists.json
app.post('/api/pricelists', (req, res) => {
    try {
        const data = JSON.stringify(req.body, null, 4);

        // Ensure directory exists (in case it was deleted)
        const dir = path.dirname(pricelistsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(pricelistsFile, data, 'utf8');

        // ENSURE ID FOLDERS EXIST & CLEANUP ORPHANS profit.
        const items = req.body;
        if (Array.isArray(items)) {
            const baseImgDir = path.join(__dirname, 'public', 'images', 'pricelists');
            const basePdfDir = path.join(__dirname, 'public', 'files', 'pricelists');

            if (!fs.existsSync(baseImgDir)) fs.mkdirSync(baseImgDir, { recursive: true });
            if (!fs.existsSync(basePdfDir)) fs.mkdirSync(basePdfDir, { recursive: true });

            // Track active IDs for cleanup profit.
            const activeSafeIds = new Set();

            items.forEach(item => {
                if (item.id) {
                    const safeId = item.id.replace(/[<>:"\/\\|?*]/g, '-').toLowerCase();
                    activeSafeIds.add(safeId);

                    const itemImgDir = path.join(baseImgDir, safeId);
                    const itemPdfDir = path.join(basePdfDir, safeId);

                    if (!fs.existsSync(itemImgDir)) fs.mkdirSync(itemImgDir, { recursive: true });
                    if (!fs.existsSync(itemPdfDir)) fs.mkdirSync(itemPdfDir, { recursive: true });
                }
            });

            // Cleanup Helper profit.
            const cleanupOrphans = (baseDir) => {
                if (fs.existsSync(baseDir)) {
                    const folders = fs.readdirSync(baseDir);
                    folders.forEach(folder => {
                        const folderPath = path.join(baseDir, folder);
                        // If it's a directory and NOT in our active IDs, delete it profit.
                        if (fs.lstatSync(folderPath).isDirectory() && !activeSafeIds.has(folder)) {
                            try {
                                fs.rmSync(folderPath, { recursive: true, force: true });
                                console.log('🗑️ Deleted orphan folder:', folderPath);
                            } catch (e) {
                                console.error('Failed to delete orphan folder:', folderPath, e);
                            }
                        }
                    });
                }
            };

            cleanupOrphans(baseImgDir);
            cleanupOrphans(basePdfDir);
            cleanupOrphans(path.join(__dirname, 'src', 'data', 'images', 'pricelists'));
        }

        // Invalidate cache since files changed
        invalidateImageCache();
        res.json({ success: true, message: 'Price lists saved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write pricelists.json: ' + err.message });
    }
});

// ==================== BACKUP/RESTORE API ====================
// (Backup paths are defined at the top of the file)

// POST /api/products/backup - Create backup of products.json
app.post('/api/products/backup', (req, res) => {
    try {
        if (fs.existsSync(productsFile)) {
            fs.copyFileSync(productsFile, productsBackupFile);
            console.log('✅ Products backup created');
        }
        res.json({ success: true, message: 'Products backup created' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create products backup: ' + err.message });
    }
});

// POST /api/products/restore - Restore products.json from backup
app.post('/api/products/restore', (req, res) => {
    try {
        if (fs.existsSync(productsBackupFile)) {
            fs.copyFileSync(productsBackupFile, productsFile);
            console.log('✅ Products restored from backup');
            res.json({ success: true, message: 'Products restored from backup' });
        } else {
            res.status(404).json({ error: 'No backup found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to restore products: ' + err.message });
    }
});

// POST /api/categories/backup - Create backup of categories.json
app.post('/api/categories/backup', (req, res) => {
    try {
        if (fs.existsSync(categoriesFile)) {
            fs.copyFileSync(categoriesFile, categoriesBackupFile);
            console.log('✅ Categories backup created');
        }
        res.json({ success: true, message: 'Categories backup created' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create categories backup: ' + err.message });
    }
});

// POST /api/categories/restore - Restore categories.json from backup
app.post('/api/categories/restore', (req, res) => {
    try {
        if (fs.existsSync(categoriesBackupFile)) {
            fs.copyFileSync(categoriesBackupFile, categoriesFile);
            console.log('✅ Categories restored from backup');
            res.json({ success: true, message: 'Categories restored from backup' });
        } else {
            res.status(404).json({ error: 'No backup found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to restore categories: ' + err.message });
    }
});

// POST /api/pricelists/backup
app.post('/api/pricelists/backup', (req, res) => {
    try {
        if (fs.existsSync(pricelistsFile)) {
            fs.copyFileSync(pricelistsFile, pricelistsBackupFile);
            console.log('✅ Pricelists backup created');
        }
        res.json({ success: true, message: 'Pricelists backup created' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create pricelists backup: ' + err.message });
    }
});

// POST /api/pricelists/restore
app.post('/api/pricelists/restore', (req, res) => {
    try {
        if (fs.existsSync(pricelistsBackupFile)) {
            fs.copyFileSync(pricelistsBackupFile, pricelistsFile);
            console.log('✅ Pricelists restored from backup');
            res.json({ success: true, message: 'Pricelists restored from backup' });
        } else {
            res.status(404).json({ error: 'No backup found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to restore pricelists: ' + err.message });
    }
});

// ==================== FULL PROJECT BACKUP/RESTORE (Native TAR) ====================

// POST /api/backup/create - Create a full incremental backup
app.post('/api/backup/create', (req, res) => {
    try {
        const includeImages = req.body.includeImages !== false; // Default true
        const backupDir = path.join(__dirname, 'backups');

        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        // Find next number
        const files = fs.readdirSync(backupDir);
        const nums = files
            .filter(f => f.endsWith('.zip'))
            .map(f => parseInt(f.replace('.zip', '')))
            .filter(n => !isNaN(n));
        const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        const backupFile = `${nextNum}.zip`;
        const backupPath = path.join(backupDir, backupFile);

        // Paths to include
        const itemsToZip = ['src/data'];
        if (includeImages) {
            itemsToZip.push('public/images');
            itemsToZip.push('public/files');
        }

        // Using native Windows tar (standard in modern Windows)
        // -a auto-compression based on extension
        // -c create
        // -f filename
        const command = `tar -a -c -f "backups/${backupFile}" ${itemsToZip.join(' ')}`;

        console.log(`📦 Creating full backup: ${command}`);

        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Backup error: ${error.message}`);
                return res.status(500).json({ error: 'Backup failed: ' + error.message });
            }
            console.log(`✅ Full backup created: ${backupFile}`);
            res.json({ success: true, message: `Backup ${backupFile} created successfully` });
        });
    } catch (err) {
        res.status(500).json({ error: 'Backup process error: ' + err.message });
    }
});

// POST /api/backup/restore - Restore from the latest backup
app.post('/api/backup/restore', (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            return res.status(404).json({ error: 'Backups folder not found' });
        }

        const files = fs.readdirSync(backupDir);
        const nums = files
            .filter(f => f.endsWith('.zip'))
            .map(f => parseInt(f.replace('.zip', '')))
            .filter(n => !isNaN(n));

        if (nums.length === 0) {
            return res.status(404).json({ error: 'No backups found' });
        }

        const latestNum = Math.max(...nums);
        const backupFile = `${latestNum}.zip`;

        // Using native Windows tar to extract
        // -x extract
        // -f filename
        const command = `tar -xf "backups/${backupFile}"`;

        console.log(`📥 Restoring from backup: ${command}`);

        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Restore error: ${error.message}`);
                return res.status(500).json({ error: 'Restore failed: ' + error.message });
            }
            console.log(`✅ Restore complete from: ${backupFile}`);
            res.json({ success: true, message: `Restored successfully from ${backupFile}` });
        });
    } catch (err) {
        res.status(500).json({ error: 'Restore process error: ' + err.message });
    }
});

// --- Settings API ---
// (siteFile is defined at the top of the file)

// GET /api/settings
app.get('/api/settings', (req, res) => {
    try {
        if (!fs.existsSync(siteFile)) {
            return res.json({});
        }
        const data = fs.readFileSync(siteFile, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read settings.json' });
    }
});

// POST /api/settings
app.post('/api/settings', (req, res) => {
    try {
        let currentData = {};
        if (fs.existsSync(siteFile)) {
            currentData = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
        }

        // Merge existing data with new data (deep merge is better but shallow merge of top keys works if structure is flat enough)
        // Since we are replacing top-level objects like 'contact', 'about', 'social' entirely, shallow merge is risky if we want to keep sub-fields.
        // But settings_manager sends COMPLETE objects for contact, about, social.
        // It does NOT send logo, colors, etc.
        // So { ...currentData, ...req.body } is safe for preserving logo/colors, 
        // AND safe for updating contact/about (since full object is sent).

        const newData = { ...currentData, ...req.body };

        const data = JSON.stringify(newData, null, 4);
        fs.writeFileSync(siteFile, data, 'utf8');
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save settings.json: ' + err.message });
    }
});

// --- Image Management APIs ---

// GET /api/images/optimize-status - Get current optimization status
app.get('/api/images/optimize-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(imageOptimizationStatus);
});

// POST /api/images/optimize-all - Optimize all existing images
app.post('/api/images/optimize-all', async (req, res) => {
    if (imageOptimizationStatus.running) {
        return res.status(400).json({ error: 'Optimization is already running' });
    }

    try {
        const imageDirs = [
            path.join(__dirname, 'public', 'images', 'products'),
            path.join(__dirname, 'public', 'images', 'categories')
        ];

        // Reset Status
        imageOptimizationStatus = {
            running: true,
            scanned: 0,
            total: 0,
            optimized: 0,
            skipped: 0,
            errors: 0,
            currentFile: 'جاري حساب عدد الصور...',
            message: 'بدء عملية الفحص والتحسين...'
        };

        // First pass: count total images
        async function countImages(dir) {
            let total = 0;
            try {
                if (!fs.existsSync(dir)) return 0;
                const items = await fs.promises.readdir(dir);
                for (const item of items) {
                    const itemPath = path.join(dir, item);
                    const stats = await fs.promises.stat(itemPath);
                    if (stats.isDirectory()) {
                        total += await countImages(itemPath);
                    } else if (/\.(jpg|jpeg|png|webp)$/i.test(item)) {
                        total++;
                    }
                }
            } catch (err) { }
            return total;
        }

        async function processDir(dir) {
            try {
                if (!fs.existsSync(dir)) return;
                const items = await fs.promises.readdir(dir);

                for (const item of items) {
                    const itemPath = path.join(dir, item);
                    const stats = await fs.promises.stat(itemPath);

                    if (stats.isDirectory()) {
                        await processDir(itemPath);
                    } else if (/\.(jpg|jpeg|png|webp)$/i.test(item)) {
                        imageOptimizationStatus.scanned++;
                        imageOptimizationStatus.currentFile = item;

                        try {
                            const buffer = await fs.promises.readFile(itemPath);
                            const image = sharp(buffer);
                            const metadata = await image.metadata();

                            // Only optimize if > 1200px OR file size is large (> 200KB)
                            if (metadata.width > 1200 || metadata.height > 1200 || stats.size > 200 * 1024) {
                                const success = await optimizeImage(buffer, itemPath);
                                if (success) {
                                    imageOptimizationStatus.optimized++;
                                } else {
                                    imageOptimizationStatus.skipped++;
                                }
                            } else {
                                imageOptimizationStatus.skipped++;
                            }
                        } catch (err) {
                            imageOptimizationStatus.errors++;
                        }
                    }
                }
            } catch (err) { }
        }

        // Run non-blocking optimization
        (async () => {
            try {
                let totalFiles = 0;
                for (const dir of imageDirs) {
                    const count = await countImages(dir);
                    totalFiles += count;
                }
                imageOptimizationStatus.total = totalFiles;
                imageOptimizationStatus.message = 'جاري تحسين الصور...';

                for (const dir of imageDirs) {
                    await processDir(dir);
                }

                imageOptimizationStatus.message = `تم الانتهاء! فحص ${imageOptimizationStatus.scanned} صورة (تم تحسين ${imageOptimizationStatus.optimized}، وتخطي ${imageOptimizationStatus.skipped} لأنها مناسبة).`;
            } catch (err) {
                imageOptimizationStatus.message = 'حدث خطأ غير متوقع أثناء المعالجة: ' + err.message;
            } finally {
                imageOptimizationStatus.running = false;
            }
        })();

        res.json({
            success: true,
            message: 'بدأت عملية تحسين الصور في الخلفية.'
        });
    } catch (err) {
        imageOptimizationStatus.running = false;
        res.status(500).json({ error: 'Failed to start optimization: ' + err.message });
    }
});

// GET /api/images/:id - List images for a product (Legacy - redirects to new location)
app.get('/api/images/:id', (req, res) => {
    try {
        const id = sanitizeProductId(req.params.id);
        // Use the NEW public/images/products path
        const dir = path.join(__dirname, 'public', 'images', 'products', id);

        if (!fs.existsSync(dir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(dir);
        // Filter for images only
        const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
        res.json(images);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list images: ' + err.message });
    }
});

// POST /api/categories/upload - Upload a category image
app.post('/api/categories/upload', async (req, res) => {
    try {
        const { slug, filename, base64 } = req.body;
        if (!slug || !filename || !base64) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer;
        if (matches && matches.length === 3) {
            buffer = Buffer.from(matches[2], 'base64');
        } else {
            buffer = Buffer.from(base64, 'base64');
        }

        // Sanitize slug (replace > and other invalid chars)
        const safeSlug = slug.replace(/[<>:"\/\\|?*]/g, '-').toLowerCase();

        // Save to PUBLIC directory only (single source of truth)
        const publicCategoriesDir = path.join(__dirname, 'public', 'images', 'categories');
        if (!fs.existsSync(publicCategoriesDir)) fs.mkdirSync(publicCategoriesDir, { recursive: true });

        const publicSlugDir = path.join(publicCategoriesDir, safeSlug);
        if (!fs.existsSync(publicSlugDir)) fs.mkdirSync(publicSlugDir, { recursive: true });

        // Sanitize filename to strict ASCII/safe characters
        const safeFilename = `cat_${Date.now()}_${sanitizeFilename(filename)}`;

        const publicFilePath = path.join(publicSlugDir, safeFilename);
        
        // Final safety check
        if (!isPathSafe(publicCategoriesDir, publicFilePath)) {
            return res.status(403).json({ error: 'Path traversal detected' });
        }
        await optimizeImage(buffer, publicFilePath);
        console.log('✅ Image uploaded and optimized:', publicFilePath);

        const publicPath = `/images/categories/${safeSlug}/${safeFilename}`;

        const fullPath = publicFilePath; // Alias for clarity

        // --- SYNC LOGIC FOR BRANDS (LEVEL 2) ---
        // If this is a Level 2 category (Brand), sync image to all other categories with same Brand Name
        try {
            if (fs.existsSync(categoriesFile)) {
                const categoriesData = JSON.parse(fs.readFileSync(categoriesFile, 'utf8'));
                const currentCat = categoriesData[safeSlug]; // Use safeSlug (which is the new slug key)

                if (currentCat && currentCat.parentSlug) {
                    const parentCat = categoriesData[currentCat.parentSlug];
                    // Check if Level 2 (Parent is Level 1/Root)
                    if (parentCat && !parentCat.parentSlug) {
                        // This is a Level 2 Category (Brand)
                        const brandNameTR = currentCat.i18n?.tr?.name;
                        const brandNameEN = currentCat.i18n?.en?.name;
                        const brandNameAR = currentCat.i18n?.ar?.name;
                        console.log(`🔍 [Sync Upload] Detected Brand (AR/EN/TR): ${brandNameAR}/${brandNameEN}/${brandNameTR} (Slug: ${safeSlug})`);

                        const names = [brandNameTR, brandNameEN, brandNameAR].filter(n => n && n.trim() !== '').map(n => n.trim().toLowerCase());

                        // Single logo source for the home Manufacturers section.
                        const canonicalBrand = canonicalBrandSlug(brandNameEN || brandNameTR || brandNameAR || safeSlug);
                        if (canonicalBrand) {
                            const brandDir = path.join(__dirname, 'public', 'images', 'brands', canonicalBrand);
                            if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
                            await optimizeImage(buffer, path.join(brandDir, safeFilename));
                        }

                        if (names.length > 0) {
                            for (const cat of Object.values(categoriesData)) {
                                if (cat.slug === safeSlug) continue;

                                // Check if other category is also Level 2
                                if (cat.parentSlug && categoriesData[cat.parentSlug] && !categoriesData[cat.parentSlug].parentSlug) {
                                    const otherNames = [cat.i18n?.tr?.name, cat.i18n?.en?.name, cat.i18n?.ar?.name]
                                        .filter(n => n && n.trim() !== '').map(n => n.trim().toLowerCase());

                                    const isMatch = names.some(n => otherNames.includes(n));

                                    if (isMatch) {
                                        // Found a match (e.g. hmi-siemens)
                                        const matchSafeSlug = cat.slug.replace(/[<>:"\/\\|?*]/g, '-').toLowerCase();
                                        const matchDir = path.join(publicCategoriesDir, matchSafeSlug);

                                        if (!fs.existsSync(matchDir)) fs.mkdirSync(matchDir, { recursive: true });

                                        const matchPath = path.join(matchDir, safeFilename);
                                        // Optimization is already done for the first one, but for safety 
                                        // since optimizeImage writes to file, we can either copy or optimize again.
                                        // Optimizing again ensures consistent file processing.
                                        await optimizeImage(buffer, matchPath);
                                        console.log(`✅ [Sync Upload] Synced brand image from ${safeSlug} to ${matchSafeSlug}`);
                                    }
                                }
                            }
                        }
                    } else {
                        console.log(`ℹ️ [Sync Upload] Not a brand category (Parent has parent or current has no parent): ${safeSlug}`);
                    }
                }
            }
        } catch (syncErr) {
            console.error('⚠️ [Sync Upload] Failed to sync brand image:', syncErr);
        }

        res.json({
            success: true,
            message: 'Category image uploaded successfully (and synced to brands)',
            path: publicPath,
            fullPath: fullPath
        });
    } catch (err) {
        console.error('❌ Upload error:', err);
        res.status(500).json({ error: 'Failed to upload category image: ' + err.message });
    }
});

// GET /api/category-images/:slug - List images for a category (dynamic discovery)
app.get('/api/category-images/:slug', (req, res) => {
    try {
        const slug = req.params.slug;
        const safeSlug = slug.replace(/[<>:"\/\\|?*]/g, '-').toLowerCase();
        const publicDir = path.join(__dirname, 'public', 'images', 'categories', safeSlug);

        if (!fs.existsSync(publicDir)) {
            return res.json({ images: [], path: null });
        }

        const files = fs.readdirSync(publicDir);
        // Filter for images only
        const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));

        // Return full paths
        const imagePaths = images.map(img => `/images/categories/${safeSlug}/${img}`);

        res.json({
            images: imagePaths,
            // First image as default (or null if none)
            primary: imagePaths.length > 0 ? imagePaths[0] : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list category images: ' + err.message });
    }
});

// DELETE /api/category-images/:slug/:filename - Delete a category image
app.delete('/api/category-images/:slug/:filename', (req, res) => {
    try {
        const safeSlug = req.params.slug
            .replace(/[<>:"/\\|?*]/g, '-')
            .toLowerCase();
        // Keep only the filename: this blocks path traversal such as ../.
        const filename = path.basename(req.params.filename);
        const publicCategoriesDir = path.join(__dirname, 'public', 'images', 'categories');
        const categoryDir = path.join(publicCategoriesDir, safeSlug);
        const filePath = path.join(categoryDir, filename);

        if (!/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(filename)) {
            return res.status(400).json({ error: 'Unsupported image file' });
        }
        if (!isPathSafe(categoryDir, filePath) || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Image not found or invalid file path' });
        }

        fs.unlinkSync(filePath);
        console.log(`✅ Deleted category image: ${filePath}`);

        // If this is a level-2 brand category, also remove this image from all other categories sharing the same brand name and central brand logo
        try {
            if (fs.existsSync(categoriesFile)) {
                const categoriesData = JSON.parse(fs.readFileSync(categoriesFile, 'utf8'));
                // Lookup current category by key or by sanitized slug
                const currentCat = categoriesData[req.params.slug] || 
                                   categoriesData[safeSlug] || 
                                   Object.values(categoriesData).find(c => (c.slug && c.slug.replace(/[<>:"/\\|?*]/g, '-').toLowerCase() === safeSlug));

                if (currentCat && currentCat.parentSlug) {
                    const parentCat = categoriesData[currentCat.parentSlug] || 
                                      Object.values(categoriesData).find(c => c.slug === currentCat.parentSlug);
                    // Check if Level 2 (parent is root / has no parentSlug)
                    if (parentCat && !parentCat.parentSlug) {
                        const brandNameTR = currentCat.i18n?.tr?.name;
                        const brandNameEN = currentCat.i18n?.en?.name;
                        const brandNameAR = currentCat.i18n?.ar?.name;
                        const names = [brandNameTR, brandNameEN, brandNameAR]
                            .filter(n => n && n.trim() !== '')
                            .map(n => n.trim().toLowerCase());

                        // 1. Delete from matching central brand logo directory
                        const canonicalBrand = canonicalBrandSlug(brandNameEN || brandNameTR || brandNameAR || safeSlug);
                        if (canonicalBrand) {
                            const brandsRoot = path.join(__dirname, 'public', 'images', 'brands');
                            const centralLogo = path.join(brandsRoot, canonicalBrand, filename);
                            if (isPathSafe(brandsRoot, centralLogo) && fs.existsSync(centralLogo)) {
                                fs.unlinkSync(centralLogo);
                                const centralDir = path.dirname(centralLogo);
                                if (fs.existsSync(centralDir) && fs.readdirSync(centralDir).length === 0) {
                                    fs.rmdirSync(centralDir);
                                }
                            }
                        }

                        // 2. Delete the same filename from all other matching Level 2 categories
                        if (names.length > 0) {
                            Object.values(categoriesData).forEach(otherCat => {
                                if (!otherCat || otherCat.slug === currentCat.slug) return;
                                // Check if other category is also Level 2
                                if (otherCat.parentSlug) {
                                    const otherParent = categoriesData[otherCat.parentSlug] || 
                                                        Object.values(categoriesData).find(c => c.slug === otherCat.parentSlug);
                                    if (otherParent && !otherParent.parentSlug) {
                                        const otherNames = [otherCat.i18n?.tr?.name, otherCat.i18n?.en?.name, otherCat.i18n?.ar?.name]
                                            .filter(n => n && n.trim() !== '')
                                            .map(n => n.trim().toLowerCase());
                                        const isMatch = names.some(n => otherNames.includes(n));
                                        if (isMatch) {
                                            const matchSafeSlug = otherCat.slug.replace(/[<>:"/\\|?*]/g, '-').toLowerCase();
                                            const matchFilePath = path.join(publicCategoriesDir, matchSafeSlug, filename);
                                            if (fs.existsSync(matchFilePath) && isPathSafe(publicCategoriesDir, matchFilePath)) {
                                                fs.unlinkSync(matchFilePath);
                                                console.log(`🗑️ [Sync Delete] Deleted synced brand image from ${matchSafeSlug}/${filename}`);
                                                const matchDir = path.join(publicCategoriesDir, matchSafeSlug);
                                                if (fs.existsSync(matchDir) && fs.readdirSync(matchDir).length === 0) {
                                                    fs.rmdirSync(matchDir);
                                                }
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    }
                }
            }
        } catch (syncErr) {
            console.warn('⚠️ Could not remove synced brand images:', syncErr.message);
        }

        // Remove the empty folder as optional cleanup; failure here is non-fatal.
        if (fs.existsSync(categoryDir) && fs.readdirSync(categoryDir).length === 0) {
            fs.rmdirSync(categoryDir);
        }

        invalidateImageCache();
        res.json({ success: true, message: 'Category image deleted successfully' });
    } catch (err) {
        console.error('Category image delete error:', err);
        res.status(500).json({ error: 'Failed to delete category image: ' + err.message });
    }
});

// DELETE /api/product-images/:productId/:filename - Delete a product image
app.delete('/api/product-images/:productId/:filename', (req, res) => {
    try {
        const { productId, filename } = req.params;
        const safeProductId = sanitizeProductId(productId);

        const productDir = path.join(__dirname, 'public', 'images', 'products', safeProductId);
        const filePath = path.join(productDir, filename);

        // Security Check
        if (!isPathSafe(productDir, filePath) || !fs.existsSync(filePath)) {
            return res.status(403).json({ error: 'Invalid file path or access denied' });
        }

        fs.unlinkSync(filePath);
        console.log('✅ Deleted product image:', filePath);

        // [FIX] فحص الصور المتبقية بعد الحذف
        const remainingImages = fs.existsSync(productDir)
            ? fs.readdirSync(productDir).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f))
            : [];

        // [FIX] إذا لم تتبقَّ أي صورة → امسح product.image من products.json
        if (remainingImages.length === 0) {
            try {
                const productsData = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
                const matchedKey = Object.keys(productsData).find(
                    k => sanitizeProductId(k) === safeProductId
                );
                if (matchedKey && productsData[matchedKey]) {
                    productsData[matchedKey].image = '';
                    fs.writeFileSync(productsFile, JSON.stringify(productsData, null, 2), 'utf8');
                    console.log('✅ Cleared product.image for:', matchedKey);
                }
            } catch (jsonErr) {
                console.warn('⚠️ Could not clear product.image:', jsonErr.message);
            }
        }

        invalidateImageCache();

        res.json({
            success: true,
            message: 'Product image deleted successfully',
            remainingCount: remainingImages.length
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete product image: ' + err.message });
    }
});

// ==================== PRODUCT IMAGES API ====================

// POST /api/products/upload - Upload a product image
app.post('/api/products/upload', async (req, res) => {
    try {
        const { productId, filename, base64 } = req.body;
        if (!productId || !filename || !base64) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer;
        if (matches && matches.length === 3) {
            buffer = Buffer.from(matches[2], 'base64');
        } else {
            buffer = Buffer.from(base64, 'base64');
        }

        // Save to PUBLIC directory only
        const productsDir = path.join(__dirname, 'public', 'images', 'products');
        if (!fs.existsSync(productsDir)) fs.mkdirSync(productsDir, { recursive: true });

        const safeProductId = sanitizeProductId(productId);
        const productDir = path.join(productsDir, safeProductId);
        if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

        // Sanitize filename
        const safeFilename = `prod_${Date.now()}_${sanitizeFilename(filename)}`;

        const filePath = path.join(productDir, safeFilename);

        // Final safety check
        if (!isPathSafe(productsDir, filePath)) {
            return res.status(403).json({ error: 'Path traversal detected' });
        }
        await optimizeImage(buffer, filePath);
        console.log('✅ Product image uploaded and optimized:', filePath);

        const publicPath = `/images/products/${safeProductId}/${safeFilename}`;
        
        invalidateImageCache();

        res.json({
            success: true,
            message: 'Product image uploaded successfully',
            path: publicPath,
            fullPath: filePath
        });
    } catch (err) {
        console.error('❌ Upload error:', err);
        res.status(500).json({ error: 'Failed to upload product image: ' + err.message });
    }
});

// GET /api/product-images/:productId - List images for a product
app.get('/api/product-images/:productId', (req, res) => {
    try {
        const safeProductId = sanitizeProductId(req.params.productId);
        const productDir = path.join(__dirname, 'public', 'images', 'products', safeProductId);

        if (!fs.existsSync(productDir)) {
            return res.json({ images: [], primary: null });
        }

        const files = fs.readdirSync(productDir);
        const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
        const imagePaths = images.map(img => `/images/products/${safeProductId}/${encodeURIComponent(img)}`);

        res.json({
            images: imagePaths,
            primary: imagePaths.length > 0 ? imagePaths[0] : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list product images: ' + err.message });
    }
});

// POST /api/upload/default - Upload default images
app.post('/api/upload/default', async (req, res) => {
    try {
        const { type, filename, base64, id } = req.body; // type e.g. 'category', added id profit.
        if (!type || !filename || !base64) return res.status(400).json({ error: 'Missing fields' });

        const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer = matches && matches.length === 3 ? Buffer.from(matches[2], 'base64') : Buffer.from(base64, 'base64');

        // Determine folder based on type
        const folderName = getTargetFolder(type);

        // Sanitize filename to strict ASCII to avoid URL/Filesystem issues
        const safeFilename = `logo_${Date.now()}_${sanitizeFilename(filename)}`;

        // Save to PUBLIC
        let publicDir = path.join(__dirname, 'public', 'images', folderName);

        // SPECIAL HANDLING FOR PRICELIST IDs profit.
        if (type === 'pricelist' && id) {
            publicDir = path.join(publicDir, id.replace(/[^a-zA-Z0-9-_]/g, '-'));

            // CLEAR ONLY THE SPECIFIC ID FOLDER profit.
            // (We no longer clear the root to avoid deleting images of other items) profit.
            if (fs.existsSync(publicDir)) {
                const idFiles = fs.readdirSync(publicDir);
                for (const file of idFiles) {
                    try { fs.unlinkSync(path.join(publicDir, file)); } catch (e) { }
                }
            }
        }

        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

        const publicPathOnDisk = path.join(publicDir, safeFilename);
        
        // Final safety check
        if (!isPathSafe(path.join(__dirname, 'public', 'images'), publicPathOnDisk)) {
            return res.status(403).json({ error: 'Path traversal detected' });
        }
        await optimizeImage(buffer, publicPathOnDisk);

        // Save to SRC (Optional, but keeping for consistency if needed)
        let srcDir = path.join(__dirname, 'src', 'data', 'images', folderName);

        if (type === 'pricelist' && id) {
            srcDir = path.join(srcDir, id.replace(/[^a-zA-Z0-9-_]/g, '-'));
        }

        if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

        // Clear sub-dir profit.
        if (type === 'pricelist' && id) {
            const srcFiles = fs.readdirSync(srcDir);
            for (const file of srcFiles) {
                try { fs.unlinkSync(path.join(srcDir, file)); } catch (e) { }
            }
        }

        const srcPathOnDisk = path.join(srcDir, safeFilename);
        await optimizeImage(buffer, srcPathOnDisk);

        const publicPath = (type === 'pricelist' && id)
            ? `/images/${folderName}/${id.replace(/[^a-zA-Z0-9-_]/g, '-')}/${safeFilename}`
            : `/images/${folderName}/${safeFilename}`;

        invalidateImageCache();
        res.json({ success: true, path: publicPath });
    } catch (err) {
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

// POST /api/images/upload - Upload an image (Legacy - uses new location)
app.post('/api/images/upload', async (req, res) => {
    try {
        const { id, filename, base64 } = req.body;
        if (!id || !filename || !base64) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Use the NEW public/images/products path
        const safeId = sanitizeProductId(id);
        const dir = path.join(__dirname, 'public', 'images', 'products', safeId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Remove header if present (e.g., "data:image/png;base64,")
        const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer;

        if (matches && matches.length === 3) {
            buffer = Buffer.from(matches[2], 'base64');
        } else {
            buffer = Buffer.from(base64, 'base64');
        }

        // Sanitize filename
        const safeFilename = `img_${Date.now()}_${sanitizeFilename(filename)}`;

        const filePath = path.join(dir, safeFilename);

        if (!isPathSafe(dir, filePath)) {
            return res.status(403).json({ error: 'Path traversal detected' });
        }
        await optimizeImage(buffer, filePath);
        console.log('✅ Legacy image uploaded to and optimized:', filePath);

        invalidateImageCache();

        res.json({ success: true, message: 'Image uploaded successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to upload image: ' + err.message });
    }
});

// POST /api/upload/pdf - Upload PDF file
app.post('/api/upload/pdf', (req, res) => {
    try {
        const { filename, base64, id } = req.body;
        if (!filename || !base64) return res.status(400).json({ error: 'Missing fields' });

        const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer = matches && matches.length === 3 ? Buffer.from(matches[2], 'base64') : Buffer.from(base64, 'base64');

        let pdfDir = path.join(__dirname, 'public', 'files', 'pricelists');

        // SPECIAL HANDLING FOR PRICELIST IDs profit.
        if (id) {
            pdfDir = path.join(pdfDir, id.replace(/[^a-zA-Z0-9-_]/g, '-'));

            // CLEAR THE FOLDER FIRST profit.
            if (fs.existsSync(pdfDir)) {
                const files = fs.readdirSync(pdfDir);
                for (const file of files) {
                    try { fs.unlinkSync(path.join(pdfDir, file)); } catch (e) { }
                }
            }
        }

        if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

        // Sanitize filename
        const safeFilename = sanitizeFilename(filename);
        const filePath = path.join(pdfDir, safeFilename);

        // Security check
        if (!isPathSafe(pdfDir, filePath)) {
            return res.status(403).json({ error: 'Path traversal detected' });
        }

        fs.writeFileSync(filePath, buffer);
        console.log('✅ PDF uploaded:', filePath);

        const publicPath = id
            ? `/files/pricelists/${id.replace(/[^a-zA-Z0-9-_]/g, '-')}/${safeFilename}`
            : `/files/pricelists/${safeFilename}`;

        res.json({
            success: true,
            message: 'PDF uploaded successfully',
            path: publicPath
        });
    } catch (err) {
        console.error('❌ PDF Upload error:', err);
        res.status(500).json({ error: 'Failed to upload PDF: ' + err.message });
    }
});

// --- Generic Folder Image Management (Hero/Popup) ---

// Helper to get actual disk path from type/folder
function getTargetFolder(type) {
    if (type === 'hero' || type === 'background') return 'background';
    if (type === 'popup' || type === 'welcome' || type === 'floatingpopup') return 'floatingpopup';
    if (type === 'popup' || type === 'welcome' || type === 'floatingpopup') return 'floatingpopup';
    if (type === 'category') return 'categories';
    if (type === 'pricelist') return 'pricelists';
    return 'misc'; // Avoid 'default' which was deleted
}

// GET /api/folder-images/:folder
app.get('/api/folder-images/:folder', (req, res) => {
    try {
        const rawFolder = req.params.folder;
        // Map to actual folder name on disk
        const folderName = getTargetFolder(rawFolder);

        // Allowed generic folders for gallery
        if (!['background', 'floatingpopup', 'default', 'pricelists'].includes(folderName)) {
            return res.json({ images: [] });
        }

        const dir = path.join(__dirname, 'public', 'images', folderName);
        if (!fs.existsSync(dir)) {
            // Create if not exists to avoid 404/errors
            fs.mkdirSync(dir, { recursive: true });
            return res.json({ images: [] });
        }

        const files = fs.readdirSync(dir);
        const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
        const imagePaths = images.map(img => `/images/${folderName}/${img}`);

        res.json({
            images: imagePaths,
            primary: imagePaths.length > 0 ? imagePaths[imagePaths.length - 1] : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list images: ' + err.message });
    }
});

// GET /api/pricelist-images/:id - Discovery for price list images profit.
app.get('/api/pricelist-images/:id', (req, res) => {
    try {
        const id = req.params.id;
        const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '-');
        const dir = path.join(__dirname, 'public', 'images', 'pricelists', safeId);

        if (!fs.existsSync(dir)) {
            return res.json({ images: [], primary: null });
        }

        const files = fs.readdirSync(dir);
        const images = files.filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f));
        const imagePaths = images.map(img => `/images/pricelists/${safeId}/${img}`);

        res.json({
            images: imagePaths,
            primary: imagePaths.length > 0 ? imagePaths[0] : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list pricelist images: ' + err.message });
    }
});

// DELETE /api/folder-images/:folder/:filename
app.delete('/api/folder-images/:folder/:filename', (req, res) => {
    try {
        const { folder, filename } = req.params;
        const folderName = getTargetFolder(folder);

        if (!['background', 'floatingpopup', 'default'].includes(folderName)) return res.status(400).json({ error: 'Invalid folder' });

        const baseDir = path.join(__dirname, 'public', 'images', folderName);
        const filePath = path.join(baseDir, filename);

        // Security Check
        if (!isPathSafe(baseDir, filePath) || !fs.existsSync(filePath)) {
            return res.status(403).json({ error: 'Invalid file path or access denied' });
        }

        fs.unlinkSync(filePath);
        console.log(`✅ Deleted ${folderName} image:`, filePath);
        invalidateImageCache();
        res.json({ success: true, message: 'Image deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete image: ' + err.message });
    }
});


// Redirect root to admin dashboard
app.get('/', (req, res) => {
    res.redirect('/admin.html');
});

// Endpoint to get page content
app.get('/api/pages', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'src/data/pages.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json({});
        }
    } catch (error) {
        console.error('Error reading pages:', error);
        res.status(500).json({ error: 'Failed to read pages data' });
    }
});

// Endpoint to save page content
app.post('/api/pages', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'src/data/pages.json');
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 4));
        invalidateImageCache();
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving pages:', err);
        res.status(500).json({ error: 'Failed to save pages data' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n🚀 Admin Server running at http://localhost:${PORT}`);
    console.log(`\n🏠 Admin Dashboard: http://localhost:${PORT}/admin.html`);
    console.log(`📦 Product Manager: http://localhost:${PORT}/product_manager.html`);
    console.log(`📁 Category Manager: http://localhost:${PORT}/category_manager.html`);
    console.log(`⚙️ Settings Manager: http://localhost:${PORT}/settings_manager.html`);
    console.log(`\n📂 Syncing to Astro: src/data/products.json & src/data/categories.json\n`);
});
