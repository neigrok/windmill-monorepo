// @ts-check
// layer: kit
// file: entities.js
// expect: 7: import 'react' is not a kit import
// expect: 8: import '@noble/hashes/sha256' is not a kit import
import { jcs } from '../sync/core/jcs.js';
import React from 'react';
import { sha256 } from '@noble/hashes/sha256';
export const x = [jcs, React, sha256];
