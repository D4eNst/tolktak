// Stickers are sent as the text "[[sticker:<id>]]".
import { type Messages, t } from '../i18n';

type EmojiGroupId = keyof Messages['chat']['emoji']['groups'];

export const EMOJI_GROUPS: { id: EmojiGroupId; icon: string; list: string }[] = [
  {
    id: 'smileys',
    icon: '😀',
    list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾',
  },
  {
    id: 'gestures',
    icon: '👍',
    list: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 🦾 ✍️ 🫶 🫡 🫠 🫣 🫢 👀 👁️ 🧠 🫀 👄 🦷',
  },
  {
    id: 'hearts',
    icon: '❤️',
    list: '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ❤️‍🔥 ❤️‍🩹 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤',
  },
  {
    id: 'nature',
    icon: '🐱',
    list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦀 🐬 🐳 🦈 🐊 🦒 🦘 🐈 🐈‍⬛ 🌵 🌲 🌴 🌱 🍀 🍁 🍄 🌸 🌹 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊',
  },
  {
    id: 'food',
    icon: '🍕',
    list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🧄 🧅 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍣 🍱 🥟 🍤 🍙 🍚 🍰 🎂 🧁 🍩 🍪 🍫 🍬 🍭 🍿 🧃 ☕ 🍵 🧋 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉',
  },
  {
    id: 'activities',
    icon: '🎮',
    list: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 ⛳ 🏹 🎣 🥊 🥋 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩',
  },
  {
    id: 'objects',
    icon: '💡',
    list: '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 📹 🎥 📺 📻 🎙️ ⏰ ⌛ 📡 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧲 🔫 💣 🔪 🛡️ 🚬 ⚰️ 🔮 💊 💉 🧬 🧪 🌡️ 🧹 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🎁 🎈 🎉 🎊 ✉️ 📦 📝 📌 📎 ✂️ 🔒 🔓',
  },
  {
    id: 'symbols',
    icon: '✅',
    list: '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❗ ❕ 〰️ ⚠️ 🚸 ⛔ 🚫 📵 🔞 ☢️ ☣️ ⬆️ ↗️ ➡️ ↘️ ⬇️ ↙️ ⬅️ ↖️ ↕️ ↔️ 🔄 🔃 🆗 🆒 🆕 🆓 🆙 🆘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 💠 🔘 🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🇷🇺 🇺🇦 🇧🇾 🇰🇿',
  },
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];
export const STREAM_REACTIONS = ['🔥', '😂', '😱', '❤️', '👏', '🍿', '💀', '🤯'];

export type Sticker = { id: string; emoji?: string; src?: string; anim: 'bounce' | 'wiggle' | 'pulse' | 'spin' | 'float' };
export type StickerPack = { id: string; name?: string; stickers: Sticker[] };

export const emojiGroupName = (id: EmojiGroupId) => t().chat.emoji.groups[id];
export const stickerPackName = (p: StickerPack) => p.name ?? t().chat.emoji.packs[p.id] ?? p.id;

export const STICKER_PACKS: StickerPack[] = [
  {
    id: 'tolk',
    stickers: [
      { id: 'hi', emoji: '👋', anim: 'wiggle' },
      { id: 'lol', emoji: '🤣', anim: 'bounce' },
      { id: 'fire', emoji: '🔥', anim: 'pulse' },
      { id: 'love', emoji: '🥰', anim: 'float' },
      { id: 'popcorn', emoji: '🍿', anim: 'bounce' },
      { id: 'cool', emoji: '😎', anim: 'float' },
      { id: 'shock', emoji: '🤯', anim: 'pulse' },
      { id: 'cry', emoji: '😭', anim: 'wiggle' },
      { id: 'party', emoji: '🥳', anim: 'bounce' },
      { id: 'think', emoji: '🤔', anim: 'float' },
      { id: 'skull', emoji: '💀', anim: 'wiggle' },
      { id: 'clap', emoji: '👏', anim: 'pulse' },
      { id: 'cat', emoji: '😼', anim: 'float' },
      { id: 'ghost', emoji: '👻', anim: 'float' },
      { id: 'gg', emoji: '🏆', anim: 'spin' },
      { id: 'sleep', emoji: '😴', anim: 'float' },
    ],
  },
];

export function findSticker(id: string): Sticker | undefined {
  for (const p of STICKER_PACKS) for (const s of p.stickers) if (s.id === id) return s;
  return undefined;
}

export const STICKER_RE = /^\[\[sticker:([\w-]+)\]\]$/;

const RECENT_KEY = 'tolktak.recentEmoji';
export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24);
  } catch {
    return [];
  }
}
export function rememberEmoji(e: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24)));
  } catch {
    /* storage unavailable */
  }
}
