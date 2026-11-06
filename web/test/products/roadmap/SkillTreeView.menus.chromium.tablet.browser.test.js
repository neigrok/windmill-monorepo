import { chromium } from 'playwright';
import { menuCases } from './skillTreeViewMenus.js';

menuCases({ browserType: chromium, width: 744 });
