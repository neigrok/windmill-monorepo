// Closed in production; off production a developer opens the Board with localStorage `windmill:board:dev` = "1".

const DEV_OPT_IN_STORAGE = 'windmill:board:dev';

export function boardOpen({ production = import.meta.env?.PROD === true, storage = globalThis.localStorage } = {}) {
  if (production) return false;
  try {
    return storage?.getItem(DEV_OPT_IN_STORAGE) === '1';
  } catch {
    return false;
  }
}
