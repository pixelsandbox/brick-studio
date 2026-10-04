// Brick colours and per-theme scene settings shared by every WebGL scene.
//
// Brick colours are sRGB hex values taken from the public LDraw / BrickLink
// colour charts for real toy bricks (Bright Red, Bright Yellow, Bright Blue,
// ...). A few are nudged a touch lighter so ACES tone mapping doesn't push
// them muddy (yellow drifts towards orange in highlights otherwise).

export const BRICK = {
  red: '#c91a09', // Bright Red
  yellow: '#f5cd2f', // Bright Yellow
  blue: '#0a5ec7', // Bright Blue
  green: '#237841', // Dark Green
  brightGreen: '#4b9f4a', // Bright Green
  orange: '#fe8a18', // Bright Orange
  lightOrange: '#f8bb3d', // Bright Light Orange
  azure: '#36aebf', // Medium Azure
  darkAzure: '#078bc9', // Dark Azure
  lime: '#bbe90b', // Lime
  pink: '#e4adc8', // Bright Pink
  magenta: '#c870a0', // Magenta / Dark Pink
  tan: '#e4cd9e', // Tan / Brick Yellow
  darkTan: '#958a73', // Dark Tan
  lightNougat: '#f6d7b3', // Light Nougat
  nougat: '#d09168', // Nougat
  mediumNougat: '#aa7d55', // Medium Nougat (warm brown minifigure skin)
  reddishBrown: '#582a12', // Reddish Brown
  sandGreen: '#a0bcac', // Sand Green
  white: '#f4f4f1', // White (pure white blows out under ACES)
  lightGrey: '#a0a5a9', // Light Bluish Gray
  darkGrey: '#6c6e68', // Dark Bluish Gray
  black: '#1b2a34', // Black
};

/** The colours a visitor can pick from in the builder (order = UI order). */
export const PICKABLE = ['red', 'yellow', 'blue', 'green', 'orange', 'azure', 'lime', 'white', 'black'];

/**
 * Scene settings per theme. `bg` matches the CSS page background so the
 * canvas can be transparent or opaque without a visible seam.
 */
export const THEMES = {
  light: {
    bg: '#f4f1ea',
    exposure: 1.0,
    envIntensity: 0.9,
    key: { color: '#fff6e8', intensity: 2.4 },
    fill: { color: '#dfe8ff', intensity: 0.6 },
    ambient: 0.25,
    shadowOpacity: 0.18,
    baseplate: 'brightGreen',
  },
  dark: {
    bg: '#111418',
    exposure: 0.95,
    envIntensity: 0.55,
    key: { color: '#ffe9cc', intensity: 2.8 },
    fill: { color: '#6f8cff', intensity: 0.9 },
    ambient: 0.12,
    shadowOpacity: 0.45,
    baseplate: 'darkGrey',
  },
};

export const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
