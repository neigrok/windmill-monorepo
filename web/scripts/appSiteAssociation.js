// The file iOS reads before it opens a roadmap's link in the iPhone app (docs/foundation/roadmap-ios.md §4).
export const ASSOCIATION_PATH = '.well-known/apple-app-site-association';

export function associationBody(team) {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('APPLE_TEAM_ID must be the ten-character Apple team identifier.');
  return JSON.stringify({ applinks: { details: [{
    appIDs: [`${team}.works.windmill.app`],
    components: [{ '/': '/t/*' }, { '/': '/', '#': '/app/t_*' }],
  }] } });
}

// The team is not in the repository, so a build given none writes no file rather than one that names another app.
export function appSiteAssociation(team) {
  const name = 'windmill:app-site-association';
  if (!team) return { name, generateBundle() { console.log('App site association: not written, APPLE_TEAM_ID is not set'); } };
  const source = associationBody(team);
  return { name, generateBundle() { this.emitFile({ type: 'asset', fileName: ASSOCIATION_PATH, source }); } };
}
