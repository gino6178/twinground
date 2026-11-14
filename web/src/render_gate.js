// Background WebGL views stop drawing while a full-screen scene (the astronaut explorer) covers them.
export const renderGate = { paused: false }
export const isMobileDevice = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches
