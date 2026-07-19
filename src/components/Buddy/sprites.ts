/**
 * Buddy ASCII sprite frames.
 * Each species has 3 frames for idle animation.
 * {E} placeholder is replaced with the eye character.
 * Line 0 is the hat slot (blank in frames 0-1).
 */

import type { Species, Eye, Hat } from '../../../electron/buddy/types'

const BODIES: Record<Species, string[][]> = {
  duck: [
    ['            ', '    __      ', '  <({E} )___  ', '   (  ._>   ', '    `--\'    '],
    ['            ', '    __      ', '  <({E} )___  ', '   (  ._>   ', '    `--\'~   '],
    ['            ', '    __      ', '  <({E} )___  ', '   (  .__>  ', '    `--\'    '],
  ],
  goose: [
    ['            ', '     ({E}>    ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
    ['            ', '    ({E}>     ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
    ['            ', '     ({E}>>   ', '     ||     ', '   _(__)_   ', '    ^^^^    '],
  ],
  blob: [
    ['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (      )  ', '   `----\'   '],
    ['            ', '  .------.  ', ' (  {E}  {E}  ) ', ' (        ) ', '  `------\'  '],
    ['            ', '    .--.    ', '   ({E}  {E})   ', '   (    )   ', '    `--\'    '],
  ],
  cat: [
    ['            ', '   /\\_/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")   '],
    ['            ', '   /\\_/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")~  '],
    ['            ', '   /\\-/\\    ', '  ( {E}   {E})  ', '  (  ω  )   ', '  (")_(")   '],
  ],
  dragon: [
    ['            ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (   ~~   ) ', '  `-vvvv-\'  '],
    ['            ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (        ) ', '  `-vvvv-\'  '],
    ['   ~    ~   ', '  /^\\  /^\\  ', ' <  {E}  {E}  > ', ' (   ~~   ) ', '  `-vvvv-\'  '],
  ],
  octopus: [
    ['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  /\\/\\/\\/\\  '],
    ['            ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  \\/\\/\\/\\/  '],
    ['     o      ', '   .----.   ', '  ( {E}  {E} )  ', '  (______)  ', '  /\\/\\/\\/\\  '],
  ],
  owl: [
    ['            ', '   /\\  /\\   ', '  (({E})({E}))  ', '  (  ><  )  ', '   `----\'   '],
    ['            ', '   /\\  /\\   ', '  (({E})({E}))  ', '  (  ><  )  ', '   .----.   '],
    ['            ', '   /\\  /\\   ', '  (({E})(-))  ', '  (  ><  )  ', '   `----\'   '],
  ],
  penguin: [
    ['            ', '  .---.     ', '  ({E}>{E})     ', ' /(   )\\    ', '  `---\'     '],
    ['            ', '  .---.     ', '  ({E}>{E})     ', ' |(   )|    ', '  `---\'     '],
    ['  .---.     ', '  ({E}>{E})     ', ' /(   )\\    ', '  `---\'     ', '   ~ ~      '],
  ],
  turtle: [
    ['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[______]\\ ', '  ``    ``  '],
    ['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[______]\\ ', '   ``  ``   '],
    ['            ', '   _,--._   ', '  ( {E}  {E} )  ', ' /[======]\\ ', '  ``    ``  '],
  ],
  snail: [
    ['            ', ' {E}    .--.  ', '  \\  ( @ )  ', '   \\_`--\'   ', '  ~~~~~~~   '],
    ['            ', '  {E}   .--.  ', '  |  ( @ )  ', '   \\_`--\'   ', '  ~~~~~~~   '],
    ['            ', ' {E}    .--.  ', '  \\  ( @  ) ', '   \\_`--\'   ', '   ~~~~~~   '],
  ],
  ghost: [
    ['            ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  ~`~``~`~  '],
    ['            ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  `~`~~`~`  '],
    ['    ~  ~    ', '   .----.   ', '  / {E}  {E} \\  ', '  |      |  ', '  ~~`~~`~~  '],
  ],
  axolotl: [
    ['            ', '}~(______)~{', '}~({E} .. {E})~{', '  ( .--. )  ', '  (_/  \\_)  '],
    ['            ', '~}(______){~', '~}({E} .. {E}){~', '  ( .--. )  ', '  (_/  \\_)  '],
    ['            ', '}~(______)~{', '}~({E} .. {E})~{', '  (  --  )  ', '  ~_/  \\_~  '],
  ],
  capybara: [
    ['            ', '  n______n  ', ' ( {E}    {E} ) ', ' (   oo   ) ', '  `------\'  '],
    ['            ', '  n______n  ', ' ( {E}    {E} ) ', ' (   Oo   ) ', '  `------\'  '],
    ['    ~  ~    ', '  u______n  ', ' ( {E}    {E} ) ', ' (   oo   ) ', '  `------\'  '],
  ],
  cactus: [
    ['            ', ' n  ____  n ', ' | |{E}  {E}| | ', ' |_|    |_| ', '   |    |   '],
    ['            ', '    ____    ', ' n |{E}  {E}| n ', ' |_|    |_| ', '   |    |   '],
    [' n        n ', ' |  ____  | ', ' | |{E}  {E}| | ', ' |_|    |_| ', '   |    |   '],
  ],
  robot: [
    ['            ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ ==== ]  ', '  `------\'  '],
    ['            ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ -==- ]  ', '  `------\'  '],
    ['     *      ', '   .[||].   ', '  [ {E}  {E} ]  ', '  [ ==== ]  ', '  `------\'  '],
  ],
  rabbit: [
    ['            ', '   (\\__/)   ', '  ( {E}  {E} )  ', ' =(  ..  )= ', '  (")__(")  '],
    ['            ', '   (|__/)   ', '  ( {E}  {E} )  ', ' =(  ..  )= ', '  (")__(")  '],
    ['            ', '   (\\__/)   ', '  ( {E}  {E} )  ', ' =( .  . )= ', '  (")__(")  '],
  ],
  mushroom: [
    ['            ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
    ['            ', ' .-O-oo-O-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
    ['   . o  .   ', ' .-o-OO-o-. ', '(__________)', '   |{E}  {E}|   ', '   |____|   '],
  ],
  chonk: [
    ['            ', '  /\\    /\\  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------\'  '],
    ['            ', '  /\\    /|  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------\'  '],
    ['            ', '  /\\    /\\  ', ' ( {E}    {E} ) ', ' (   ..   ) ', '  `------\'~ '],
  ],
}

const HAT_LINES: Record<Hat, string> = {
  none: '',
  crown: '   \\^^^/    ',
  tophat: '   [___]    ',
  propeller: '    -+-     ',
  halo: '   (   )    ',
  wizard: '    /^\\     ',
  beanie: '   (___)    ',
  tinyduck: '    ,>      ',
}

/** Render sprite as array of strings with eye/hat substitution */
export function renderSprite(
  species: Species,
  eye: Eye,
  hat: Hat,
  frame = 0,
): string[] {
  const frames = BODIES[species]
  if (!frames) return ['']
  const body = frames[frame % frames.length]!.map(line =>
    line.replaceAll('{E}', eye),
  )
  const lines = [...body]
  if (hat !== 'none' && !lines[0]!.trim()) {
    lines[0] = HAT_LINES[hat]
  }
  // Remove leading blank lines if all frames have empty line 0
  if (!lines[0]!.trim() && frames.every(f => !f[0]!.trim())) lines.shift()
  return lines
}

/** Single-line face representation for compact view */
export function renderFace(species: Species, eye: Eye): string {
  const faces: Record<Species, string> = {
    duck: `(${eye}>`,
    goose: `(${eye}>`,
    blob: `(${eye}${eye})`,
    cat: `=${eye}ω${eye}=`,
    dragon: `<${eye}~${eye}>`,
    octopus: `~(${eye}${eye})~`,
    owl: `(${eye})(${eye})`,
    penguin: `(${eye}>)`,
    turtle: `[${eye}_${eye}]`,
    snail: `${eye}(@)`,
    ghost: `/${eye}${eye}\\`,
    axolotl: `}${eye}.${eye}{`,
    capybara: `(${eye}oo${eye})`,
    cactus: `|${eye}  ${eye}|`,
    robot: `[${eye}${eye}]`,
    rabbit: `(${eye}..${eye})`,
    mushroom: `|${eye}  ${eye}|`,
    chonk: `(${eye}.${eye})`,
  }
  return faces[species] || `(${eye})`
}
