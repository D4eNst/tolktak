import type en from '../en';
import chat from './chat';
import common from './common';
import core from './core';
import desk from './desk';
import groups from './groups';
import launch from './launch';
import settings from './settings';
import shell from './shell';
import moderation from './moderation';

const ru: typeof en = { common, chat, shell, settings, groups, core, launch, desk, moderation };

export default ru;
