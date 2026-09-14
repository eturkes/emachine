import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const root = new URL('../web/public/icons/', import.meta.url);
await mkdir(root, { recursive: true });
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="102" fill="#0c1218"/><rect x="75" y="75" width="362" height="362" rx="66" fill="#142820" stroke="#2d5445" stroke-width="4"/><path d="M334 175H226c-42 0-64 26-64 80s22 82 67 82h100v-42h-98c-16 0-25-10-27-24h137v-41c0-32-18-55-47-55zm-131 60c3-14 12-22 27-22h57c12 0 18 7 18 22z" fill="#7cddba"/></svg>`);
for (const size of [180, 192, 512]) await sharp(svg).resize(size, size).png().toFile(new URL(`${size}.png`, root).pathname);
