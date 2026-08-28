const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// The domain layer imports with explicit .ts extensions because it also runs
// under Node's native TypeScript stripping (`npm test`, `npm run catalog`),
// which requires them. Metro resolves those fine, but the extension has to be
// in sourceExts for the resolver to try it.
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'ts', 'tsx'])];

// The prebuilt exercise catalog ships as a binary asset, so Metro has to treat
// .db as something to bundle rather than something to parse.
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, 'db'])];

module.exports = withNativeWind(config, { input: './global.css' });
