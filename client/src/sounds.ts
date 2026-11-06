export const SOUND_THEMES = ['tok-tak', 'wood-low', 'velvet'] as const;
export const SOUND_KINDS = ['join', 'leave', 'peer-join', 'peer-leave', 'mute', 'unmute', 'ptt-on', 'ptt-off', 'message', 'ring', 'test'] as const;
export type SoundTheme = (typeof SOUND_THEMES)[number];
export type SoundKind = (typeof SOUND_KINDS)[number];
export const SOUND_ASSETS = SOUND_THEMES.flatMap(theme => SOUND_KINDS.map(kind => `sounds/${theme}/${kind}.ogg`));
