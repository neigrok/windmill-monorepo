import { Registry, RegistryError } from './registry.js';

export function composeRegistry(manifest, documents) {
  const fail = (message) => { throw new RegistryError(`composition: ${message}`); };
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'composition,registries'
    || typeof manifest.composition !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.composition)
    || !Array.isArray(manifest.registries) || !manifest.registries.length) fail('requires a name and nonempty registry list');

  const joined = { registry: manifest.composition, products: {}, types: [], commands: [] };
  const files = new Set(), types = new Set(), commands = new Set();
  for (const file of manifest.registries) {
    if (typeof file !== 'string' || !/^[a-z][a-z0-9-]*\.registry\.json$/.test(file)) fail('invalid registry filename');
    if (files.has(file)) fail(`repeats registry ${file}`);
    files.add(file);
    if (!Object.hasOwn(documents, file)) fail(`no registered document ${file}`);
    const document = documents[file];
    if (!Number.isSafeInteger(document.version) || !Number.isSafeInteger(document.minVersion)
      || document.minVersion < 1 || document.minVersion > document.version) fail('invalid version interval');
    if (joined.version !== undefined && (joined.version !== document.version || joined.minVersion !== document.minVersion)) fail('registries disagree on version interval');
    joined.version = document.version;
    joined.minVersion = document.minVersion;
    for (const [name, product] of Object.entries(document.products)) {
      if (Object.hasOwn(joined.products, name)) fail(`repeats product ${name}`);
      Object.defineProperty(joined.products, name, { value: product, enumerable: true, writable: true, configurable: true });
    }
    for (const type of document.types) {
      if (types.has(type.type)) fail(`repeats type ${type.type}`);
      types.add(type.type);
      joined.types.push(type);
    }
    for (const command of document.commands ?? []) {
      if (commands.has(command.name)) fail(`repeats command ${command.name}`);
      commands.add(command.name);
      joined.commands.push(command);
    }
    new Registry(document);
  }
  new Registry(joined);
  return joined;
}
