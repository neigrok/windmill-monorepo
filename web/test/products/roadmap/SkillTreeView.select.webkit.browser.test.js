import { webkit } from 'playwright';
import { selectCases } from './skillTreeViewSelect.js';

selectCases({ browserType: webkit });
