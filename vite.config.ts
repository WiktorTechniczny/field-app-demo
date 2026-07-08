import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        basicSsl(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
            manifest: {
                name: 'Spotkania Handlowe',
                short_name: 'Spotkania',
                description: 'Aplikacja do planowania, obsługi i raportowania spotkań handlowców w terenie.',
                theme_color: '#0f172a',
                background_color: '#0f172a',
                display: 'standalone',
                orientation: 'portrait',
                scope: '/',
                start_url: '/',
                icons: [
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any maskable',
                    },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                runtimeCaching: [],
            },
        }),
    ],
    server: {
        proxy: {
            '/api/wfs-kielce': {
                target: 'http://geoportal.powiat.kielce.pl',
                changeOrigin: true,
                secure: false,
                rewrite: (path) => path.replace(/^\/api\/wfs-kielce/, '/map/geoportal/wfs.php')
            }
        }
    }
})
