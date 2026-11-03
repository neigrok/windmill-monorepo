// The Board opens only with the device opt-in `windmill:board:dev` = "1", including production.

const DEV_OPT_IN_STORAGE = 'windmill:board:dev';

export function boardOpen({ storage } = {}) {
  try {
    const deviceStorage = storage === undefined ? globalThis.localStorage : storage;
    return deviceStorage?.getItem(DEV_OPT_IN_STORAGE) === '1';
  } catch {
    return false;
  }
}
