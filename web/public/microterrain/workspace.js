// i18n v2: display-string helpers from /i18n/static-i18n.js (identity fallback keeps the Chinese page working without it)
var __t = (typeof window !== 'undefined' && window.__t) || (s => s), __m = (typeof window !== 'undefined' && window.__m) || ((p, ...v) => p.map((x, i) => x + (i < v.length ? String(v[i]) : '')).join(''))
/* Presentation controls: API data and research scoring remain in app.js. */
function setExplorerStage(stage, scroll = true) {
  if (stage === 'results' && !response) return;
  document.getElementById('selection-workspace').hidden = stage !== 'select';
  document.getElementById('results-workspace').hidden = stage !== 'results';
  document.querySelectorAll('.workspace-steps [data-stage]').forEach(button => {
    button.classList.toggle('active', button.dataset.stage === stage);
    button.setAttribute('aria-pressed', String(button.dataset.stage === stage));
  });
  if (scroll) document.querySelector('.workspace-steps').scrollIntoView({block:'start', behavior:'smooth'});
}
function setMapView(view) {
  ['local', 'region', 'global'].forEach(name => { document.getElementById(`map-${name}`).hidden = name !== view; });
  document.querySelectorAll('[data-map-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.mapView === view);
    button.setAttribute('aria-pressed', String(button.dataset.mapView === view));
  });
  if (view === 'global') requestAnimationFrame(syncCoverageSize);
}
function updateWorkspaceSite() {
  const picker = document.getElementById('primary-site');
  if (metadata && !picker.dataset.ready) {
    picker.replaceChildren();
    for (const [label, rows] of [[__t('月球'), metadata.moon_sites], [__t('火星'), metadata.mars_sites]]) {
      const group = document.createElement('optgroup'); group.label = label;
      for (const row of rows || []) {
        const option = document.createElement('option'); option.value = row.id; option.textContent = __t(row.label); group.append(option);
      }
      picker.append(group);
    }
    picker.dataset.ready = 'true'; picker.disabled = false;
  }
  if (metadata) picker.value = tileParent(site);
}
function showWorkspaceResults() {
  document.getElementById('query-title').textContent = __m`${response.site_label} · ${response.size_m} m 方框`;
  document.querySelector('.workspace-steps [data-stage="results"]').disabled = false;
  setExplorerStage('results');
}
function updateWorkspaceCandidate(row) {
  document.getElementById('candidate-name').textContent = __t(row.site_label);
  document.getElementById('candidate-summary').textContent = row.height_rmse_m != null
    ? __m`對齊後高差 RMSE ${row.height_rmse_m.toFixed(1)} m · 起伏為查詢的 ${row.earth_to_query_relief_ratio.toFixed(2)} 倍。僅描述形狀與高差，未驗證地質成因。`
    : __m`正規化形狀差 ${row.shape_gap.toFixed(3)}，越小代表此幾何量測越接近；不是類比機率。`;
  document.getElementById('scenario-unavailable').hidden = response.mode === 'native';
  document.querySelectorAll('#matches button').forEach((button, index) => button.setAttribute('aria-pressed', String(index === selected)));
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-stage]').forEach(button => button.addEventListener('click', () => setExplorerStage(button.dataset.stage)));
  document.querySelectorAll('[data-map-view]').forEach(button => button.addEventListener('click', () => setMapView(button.dataset.mapView)));
  document.getElementById('primary-site').addEventListener('change', async event => {
    document.getElementById('site').value = event.target.value;
    await changeSite(); setMapView('local');
  });
  document.querySelectorAll('[data-result-view]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-result-view]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
      document.getElementById(`view-${item.dataset.resultView}`).hidden = !active;
    });
  }));
  document.querySelectorAll('[data-geometry-view]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-geometry-view]').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
      document.getElementById(`geometry-${item.dataset.geometryView}`).hidden = !active;
    });
  }));
});
