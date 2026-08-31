import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import path from 'node:path';

import sitemap from '@astrojs/sitemap';

// Custom Vite plugin to watch src/data JSON files and public/images and trigger live reload
function dataWatcherPlugin() {
    return {
        name: 'vite-plugin-watch-data-files',
        configureServer(server) {
            const dataDir = path.resolve('./src/data');
            const imagesDir = path.resolve('./public/images');

            server.watcher.add([dataDir, imagesDir]);

            const handleFileChange = (changedPath) => {
                const normalized = changedPath.replace(/\\/g, '/');
                if (normalized.includes('/src/data/') || normalized.includes('/public/images/')) {
                    console.log(`📡 [Auto Live-Reload] Detected change in: ${path.basename(changedPath)}, reloading site...`);
                    server.ws.send({
                        type: 'full-reload',
                        path: '*'
                    });
                }
            };

            server.watcher.on('change', handleFileChange);
            server.watcher.on('add', handleFileChange);
            server.watcher.on('unlink', handleFileChange);
        }
    };
}

// قراءة إعدادات النشر من deployment.json
let siteUrl = 'https://obsimatic.github.io';
let basePath = '/';

try {
    const deploymentConfig = JSON.parse(fs.readFileSync('./src/data/deployment.json', 'utf-8'));
    siteUrl = deploymentConfig.site || siteUrl;
    basePath = deploymentConfig.base || basePath;
} catch (e) {
    console.warn("Could not read deployment.json, using defaults.");
}

// في وضع التطوير المحلي فقط (npm run dev)، استخدم الجذر
const isDev = process.env.NODE_ENV === 'development';
if (isDev) {
    basePath = '/';
    siteUrl = 'http://localhost:4321';
}

console.log(`\n🚀 Building with SITE: "${siteUrl}" and BASE PATH: "${basePath}"\n`);

// https://astro.build/config
export default defineConfig({
    site: siteUrl,
    base: basePath,

    build: {
        assets: 'assets',
    },

    vite: {
        plugins: [dataWatcherPlugin()],
        build: {
            rollupOptions: {
                output: {
                    entryFileNames: 'assets/bundle-[name]-[hash].js',
                    chunkFileNames: 'assets/bundle-[name]-[hash].js',
                    assetFileNames: 'assets/bundle-[name]-[hash][extname]',
                },
            },
        },
    },

    integrations: [sitemap()]
});