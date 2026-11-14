// Normal human walking: mean sagittal joint angles (degrees) over one gait cycle, every 2% from left heel
// strike (0) to the next (100). Averaged from the 200 unbraced cycles (10 adults x 10 trials x 2 legs) of
// Helwig, N. & Hsiao-Wecksler, E. (2016). Multivariate Gait Data [Dataset]. UCI Machine Learning Repository.
// https://doi.org/10.24432/C5861T (CC BY 4.0). Signs: hip and knee flexion positive, ankle dorsiflexion positive.
// Toe-off falls near 62% of the cycle.
export const GAIT_REFERENCE = {
  hip: [21.8, 21.8, 21.7, 21.4, 20.9, 20.1, 19.3, 18.1, 16.5, 14.7, 12.7, 10.9, 9.1, 7.3, 5.6, 3.9, 2.3, 0.9, -0.5, -1.8, -3.0, -4.1, -5.3, -6.5, -7.5, -8.4, -9.1, -9.6, -9.7, -9.2, -7.8, -5.4, -2.2, 1.3, 5.0, 8.6, 12.1, 15.3, 18.4, 21.1, 23.3, 25.2, 26.6, 27.6, 27.9, 27.6, 26.7, 25.3, 23.7, 22.4, 21.8],
  knee: [3.1, 4.2, 6.5, 9.0, 11.3, 13.4, 15.5, 16.9, 17.6, 17.6, 17.2, 16.5, 15.8, 15.0, 14.1, 13.2, 12.3, 11.5, 10.7, 10.0, 9.4, 8.8, 8.4, 8.3, 8.7, 9.6, 11.1, 13.2, 16.2, 20.3, 25.6, 32.1, 39.3, 46.6, 53.5, 59.4, 64.1, 67.1, 68.2, 67.6, 65.3, 61.5, 56.5, 50.4, 43.3, 35.5, 27.1, 18.6, 10.9, 5.4, 3.2],
  ankle: [3.8, 3.6, 2.2, 0.1, -1.4, -1.5, -0.3, 1.4, 3.1, 4.3, 5.3, 6.1, 6.8, 7.4, 7.8, 8.3, 8.8, 9.3, 9.8, 10.3, 10.8, 11.4, 12.1, 12.8, 13.6, 14.3, 14.9, 15.2, 15.1, 14.1, 11.9, 8.1, 2.8, -3.1, -7.8, -9.8, -8.8, -6.0, -3.1, -0.6, 1.4, 3.1, 4.3, 4.9, 4.9, 4.4, 3.5, 2.7, 2.5, 3.0, 3.7],
}

// Linear interpolation into a curve at a cycle fraction (0..1, wraps).
export function sampleGait(curve, u) {
  const x = (((u % 1) + 1) % 1) * (curve.length - 1), i = Math.floor(x), f = x - i
  return curve[i] + (curve[Math.min(curve.length - 1, i + 1)] - curve[i]) * f
}
