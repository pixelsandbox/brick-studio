/**
 * @fileoverview Default configuration for the Modular 3D LEGO Hero Component.
 *
 * Anyone using this component can customize the 3D LEGO word, brick color
 * palette, minifigure visibility, and hero copy right here — or override any
 * field via HTML `data-*` attributes on `.hero`, URL query params (`?word=ALEX`),
 * or at runtime via `window.LegoHero.configure({...})` / the Customize modal.
 */

export const HERO_CONFIG = {
  /**
   * The word built in 3D LEGO bricks on the baseplate (1–10 chars: A–Z, 0–9, ! ? - & .).
   */
  brickWord: 'SUJIT',

  /**
   * Brick color palette preset ('classic' | 'bauhaus' | 'cyber' | 'warm' | 'ocean' | 'mono')
   * or an array of palette keys from `js/webgl/palette.js`.
   */
  brickPalette: 'classic',

  /**
   * Whether to show the 3D interactive minifigure on the right of the baseplate.
   */
  showMinifig: true,

  /**
   * Top header bar brand name.
   */
  brandName: 'Brick Hero',

  /**
   * Top-left box-art badge and kicker label.
   */
  badgeNumber: '3D',
  badgeUnit: 'kit',
  kicker: 'Open-Source Modular Hero Component',

  /**
   * Main hero heading.
   */
  greeting: 'Interactive 3D',
  name: 'Brick Studio.',

  /**
   * Split-flap rotating feature board.
   */
  roleLabel: 'Built with',
  roles: [
    'Custom 3D word builder',
    'Rigid-body brick physics',
    'Interactive 3D minifigure',
    'Zero-build ES modules',
  ],

  /**
   * Tagline below the split-flap board (`taglineAccent` is highlighted in brick red).
   */
  taglinePrefix: 'A playful, modular 3D playground for the web. Knock pieces loose, throw bricks around, or spell ',
  taglineAccent: 'any word',
  taglineSuffix: ' on the baseplate.',

  /**
   * Primary call-to-action button (opens the word customizer modal by default).
   */
  ctaLabel: 'Build your word',

  /**
   * Footer credit.
   */
  authorName: 'Sujit Pradhan',
  authorUrl: 'https://www.sujitpradhan.com',
};

/**
 * Quick preset words shown in the interactive customizer modal.
 */
export const WORD_PRESETS = ['SUJIT', 'HELLO', 'DESIGN', 'CREATE', 'PIXEL', 'MAKER'];
