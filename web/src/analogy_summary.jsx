// Answers the challenge objective directly: which characteristics give a strong analogy, where the analogy breaks
// down, and what no place on Earth can reproduce. The three lists come from the condition verdicts of the active
// candidate; the limits table holds fixed physical values for the Moon, Mars and Earth.
import React from 'react'
import { getLanguage } from './i18n/core.js'
import { ProcessDimensions } from './process_dimensions.jsx'

const tr = (zh, en) => (getLanguage() === 'en' ? en : zh)
const pick = t => (t ? (getLanguage() === 'en' ? t.en : t.zh) : '')

// [quantity, Moon, Mars, Earth, what it means on the Moon, what it means on Mars, close on Mars?]
const LIMITS = [
  [['重力', 'Gravity'], ['1.62 m/s²（地球的 17%）', '1.62 m/s² (17% of Earth)'], ['3.71 m/s²（地球的 38%）', '3.71 m/s² (38% of Earth)'], ['9.81 m/s²', '9.81 m/s²'],
    ['步態、車輛牽引力與揚塵軌跡都不同', 'Gait, wheel traction and dust trajectories all differ'], ['步態、車輛牽引力與揚塵軌跡都不同', 'Gait, wheel traction and dust trajectories all differ']],
  [['地表氣壓', 'Surface pressure'], ['約 10⁻¹⁰ Pa（近乎真空）', 'about 10⁻¹⁰ Pa (near vacuum)'], ['約 610 Pa（地球的 0.6%，以 CO₂ 為主）', 'about 610 Pa (0.6% of Earth, mostly CO₂)'], ['101,325 Pa', '101,325 Pa'],
    ['真空下的散熱、密封、除塵與材料釋氣無法在現地測試', 'Heat rejection, seals, dust removal and outgassing in vacuum cannot be tested on site'],
    ['風沙搬運、對流散熱與降落減速的條件不同', 'Aeolian transport, convective cooling and descent braking behave differently']],
  [['地表輻射', 'Surface radiation'], ['約 1.4 mSv／日', 'about 1.4 mSv a day'], ['約 0.64 mSv／日', 'about 0.64 mSv a day'], ['約 0.007 mSv／日', 'about 0.007 mSv a day'],
    ['劑量與屏蔽設計無法在現地驗證', 'Dose and shielding cannot be verified on site'], ['劑量與屏蔽設計無法在現地驗證', 'Dose and shielding cannot be verified on site']],
  [['一個晝夜', 'One day–night cycle'], ['約 29.5 個地球日', 'about 29.5 Earth days'], ['24 小時 40 分', '24 h 40 min'], ['24 小時', '24 h'],
    ['約 14 天的月夜對電力與保溫的考驗無法重現', 'The 14-day lunar night for power and thermal survival cannot be reproduced'],
    ['與地球接近，日照週期可以直接類比', 'Close to Earth, so the daily light cycle is a fair analog'], true],
  [['地表溫度範圍', 'Surface temperature range'], ['赤道約 −133 至 121 °C', 'about −133 to 121 °C at the equator'], ['約 −153 至 20 °C', 'about −153 to 20 °C'], ['−89 至 57 °C（全球極值）', '−89 to 57 °C (global extremes)'],
    ['現地氣溫只涵蓋其中一小段', 'Field temperatures cover only a small part of this range'], ['只有極區冬季接近火星的白天溫度', 'Only polar winters approach Martian daytime temperatures']],
]

const GROUPS = [
  [2, 'is-strong', '✓', ['強類比', 'Strong analogy'], ['這個候選沒有完全相符的條件。', 'No condition is a full match for this candidate.']],
  [1, 'is-partial', '~', ['部分相符', 'Partial'], ['沒有部分相符的條件。', 'No partial matches.']],
  [0, 'is-break', '✗', ['類比不成立', 'Analogy breaks down'], ['在已評估的條件裡沒有不符的項目。', 'No assessed condition is a mismatch.']],
]

export function AnalogySummary({ rows, body, env, lat, lon }) {
  const mars = body === 'mars'
  const unknown = rows.filter(r => !(r.verdict >= 0))
  return <div className="analogy" aria-labelledby="analogy-title">
    <h3 id="analogy-title">{tr('類比在哪裡成立、在哪裡不成立', 'Where the analogy holds and where it breaks down')}</h3>
    <div className="analogy-cols">
      {GROUPS.map(([verdict, cls, mark, title, empty]) => {
        const list = rows.filter(r => r.verdict === verdict)
        return <section key={verdict} className={`analogy-col ${cls}`}>
          <h4><span aria-hidden="true">{mark}</span> {tr(...title)} <small>{list.length}</small></h4>
          {list.length ? <ul>{list.map(r => <li key={r.id}><b>{pick(r.label)}</b><span>{pick(r.earth)}</span></li>)}</ul> : <p>{tr(...empty)}</p>}
        </section>
      })}
    </div>
    {unknown.length > 0 && <p className="analogy-unknown">{tr('沒有資料、未評估：', 'No data, not assessed: ')}{unknown.map(r => pick(r.label)).join(tr('、', ', '))}</p>}

    <h3>{tr('溫度、沙塵、生物、作用過程與日照', 'Temperature, dust, biology, processes and sunlight')}</h3>
    <p className="cond-note">{tr(
      '這五張卡片以 2001–2025 年氣候資料，回答「這些現象能不能在這裡演練」。下方「十個面向」則逐項比對目標星球的性質（例如鬆散細粒表土、緯度模型的年均溫、地質背景的作用過程），兩者判定可以不同。',
      'These five cards ask whether each phenomenon can be rehearsed here, from 2001–2025 climate data. The ten facets ask a different question: does Earth match a property of the target (for example loose fine topsoil, a latitude-model mean temperature, or the process behind the geologic setting). The two verdicts can therefore differ.')}</p>
    <ProcessDimensions env={env} body={body} rows={rows} lat={lat} lon={lon} />

    <h3>{tr('地球作為類比的極限', 'The limits of Earth as an analog')}</h3>
    <div className="analogy-table-wrap">
      <table className="analogy-limits">
        <thead><tr><th scope="col">{tr('條件', 'Condition')}</th><th scope="col">{mars ? tr('火星', 'Mars') : tr('月球', 'Moon')}</th><th scope="col">{tr('地球', 'Earth')}</th><th scope="col">{tr('對現地測試的意義', 'What it means for field tests')}</th></tr></thead>
        <tbody>{LIMITS.map(([name, moon, marsValue, earth, moonNote, marsNote, close]) => <tr key={name[1]} className={mars && close ? 'is-close' : ''}>
          <th scope="row">{tr(...name)}</th><td>{tr(...(mars ? marsValue : moon))}</td><td>{tr(...earth)}</td><td>{tr(...(mars ? marsNote : moonNote))}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="cond-note">{tr(
      '這些差異與候選地點無關。在這裡得到的行走、熱控、電力與輻射結果，不能直接外推到' + (mars ? '火星' : '月球') + '；上方相符的條件才是這個場址能提供的類比。',
      'These differences hold for every candidate. Results on walking, thermal control, power and radiation gathered here do not transfer directly to ' + (mars ? 'Mars' : 'the Moon') + '; the matching conditions above are what this site offers as an analog.')}</p>
  </div>
}
