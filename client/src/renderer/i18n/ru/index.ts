import type en from '../en';
import chat from './chat';
import common from './common';
import core from './core';
import groups from './groups';
import settings from './settings';
import shell from './shell';

const ru: typeof en = { common, chat, shell, settings, groups, core };

export default ru;
