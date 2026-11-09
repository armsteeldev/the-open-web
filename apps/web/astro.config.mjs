import { defineConfig } from 'astro/config';
export default defineConfig({vite:{build:{assetsInlineLimit:0},server:{proxy:{'/api':{target:process.env.WEB_API_TARGET ?? 'http://127.0.0.1:4322',ws:true}}}}});
