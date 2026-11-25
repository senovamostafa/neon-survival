/**
 * Colour themes for the arena. The theme changes every sector (60 s of survival),
 * which is the "complete visual transformation" of the arena. Danger stays red in every
 * theme so it is always recognisable.
 */
export interface Theme {
  name: string;
  background: string;
  floorDots: string;
  border: string;
  barrier: string;
  barrierEdge: string;
}

export const THEMES: Theme[] = [
  { name: 'Neon grid', background: '#1d1f3a', floorDots: '#ffffff', border: '#b9bfd6', barrier: '#3f4fb8', barrierEdge: '#8f9bff' },
  { name: 'Purple haze', background: '#2b1a47', floorDots: '#e5d0ff', border: '#c9a8ff', barrier: '#7a3fb8', barrierEdge: '#d9a8ff' },
  { name: 'Deep teal', background: '#103a3c', floorDots: '#c8fff2', border: '#7ff0d8', barrier: '#1f8a7a', barrierEdge: '#7ff0d8' },
  { name: 'Amber dusk', background: '#3a2a14', floorDots: '#ffe6bf', border: '#ffc27a', barrier: '#a86a2c', barrierEdge: '#ffc27a' },
];
