export { escape, icon, person, ava, face, picture, fill, clock, plan } from '../assets/js/markup.js';

export const logo = (size = 30) => `<img src="/img/logo.svg" width="${size}" height="${size}" alt="">`;

export const json = (id, data) => `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
