import type en from '../en';
import chat from './chat';
import common from './common';
import core from './core';
import groups from './groups';
import launch from './launch';
import settings from './settings';
import shell from './shell';

const ru: typeof en = { common, chat, shell, settings, groups, core, launch };

export default ru;
