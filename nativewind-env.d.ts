/// <reference types="nativewind/types" />

// TypeScript 6 rejects side-effect imports without a declaration (TS2882).
// `global.css` is consumed by Metro via the NativeWind transformer, never by tsc.
declare module '*.css';
