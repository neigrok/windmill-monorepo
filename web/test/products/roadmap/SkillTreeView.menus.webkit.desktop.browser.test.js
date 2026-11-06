import { webkit } from 'playwright';
import { menuCases } from './skillTreeViewMenus.js';

menuCases({ browserType: webkit, width: 1440 });
