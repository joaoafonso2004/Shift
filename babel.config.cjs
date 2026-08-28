module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    // Reanimated 4 moved worklet transformation into react-native-worklets.
    // This plugin MUST stay last: it rewrites functions carrying the 'worklet'
    // directive, and anything running after it would transform code the worklet
    // runtime has already been handed.
    plugins: ['react-native-worklets/plugin'],
  };
};
