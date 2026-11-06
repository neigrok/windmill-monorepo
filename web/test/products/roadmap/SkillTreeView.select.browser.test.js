import { chromium } from 'playwright';
import { selectCases } from './skillTreeViewSelect.js';

selectCases({ browserType: chromium });
