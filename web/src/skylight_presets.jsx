// NASA-described skylights / pits (LROC pit atlas; MGC3) that also lie on a high-resolution image we hold.
export const SKYLIGHT_PRESETS = {
  moon: [
    { name: 'Marius Hills 天窗坑', lat: 14.0917, lon: -56.7701 },
    { name: '寧靜海天窗坑', lat: 8.3355, lon: 33.222 },
    { name: 'Ingenii 天窗坑', lat: -35.9494, lon: 166.0559 },
  ],
  mars: [
    { name: 'Pavonis Mons 天窗', lat: 3.75879, lon: -111.51709 },
    { name: 'Hephaestus 塌陷坑', lat: 21.52222, lon: 122.04605 },
  ],
}

export function SkylightPresets({ body, onPick }) {
  return <div className="skylight-presets" role="group" aria-label="NASA 介紹過的天窗坑">
    <span>NASA 介紹過的天窗坑：</span>
    {SKYLIGHT_PRESETS[body].map(p => <button key={p.name} type="button" className="outline-button" onClick={() => onPick(p.lat, p.lon)}>{p.name}</button>)}
  </div>
}
