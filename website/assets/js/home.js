import { visible } from './site.js';
import './home/world.js';
import './home/hero.js';
import './home/house.js';
import './home/chat.js';
import './home/voice.js';
import './home/screen.js';
import './home/sound.js';
import './home/server.js';
import './home/finale.js';

// CSS loops pause while their section is off screen.
document.querySelectorAll('main section[id]').forEach(section => visible(section, () => section.classList.remove('is-away'), () => section.classList.add('is-away')));
