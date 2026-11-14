// Search purposes offered on the selection page and named on the results page.
import { getLanguage } from './i18n/core.js'

export const PURPOSES = {
  conditions: { label: '條件優先（環境＋地質＋資源）', note: '先找出環境、地質與資源條件都相符的地球地點（乾燥、裸露、低溫、岩性、火山背景、地下冰、含水礦物等，依查詢地自動決定），再依地形相似度排序；每個候選附條件對照、能測什麼與交通。條件相符代表同類場域，實測物理性質（例如化學成分）不一定相符。' },
  maxmatch: {
    get label() { return getLanguage() === 'en' ? 'Measured match (most measured properties agree)' : '實測資料比對（符合最多項實測資料）' },
    get note() {
      return getLanguage() === 'en'
        ? 'Reads up to 12 measured properties of the Moon or Mars window (slope, FeO, TiO2, K, Th, surface temperature, ground ice, dust, wind, albedo) and ranks every Earth window by how many of them agree within a fixed tolerance. No geologic rule and no learned model; properties no place on Earth reaches are listed as Earth limits.'
        : '讀取月球或火星窗格最多 12 項實測資料（坡度、FeO、TiO₂、鉀、釷、地表溫度、地下冰、塵、風、反照率），依「有幾項在容許差之內」替每個地球窗格排序。不用任何地質規則或學習模型；地球上沒有地方做得到的項目會列為地球的極限。'
    },
  },
  facets: {
    get label() { return getLanguage() === 'en' ? 'All facets (ten scored together)' : '全面向（十個面向一起計分）' },
    get note() {
      return getLanguage() === 'en'
        ? 'Scores every consideration of the challenge together: terrain, surface material, thermal, sunlight, water and ice, dust and wind, surface processes, habitability, subsurface and operations. Each candidate shows which facets hold, which break down and which have no Earth data, next to the best any place on Earth reaches.'
        : '把挑戰列出的考量一起計分：地形、表面材質、熱環境、日照、水與冰、沙塵與風、地表作用、適居性、地下、作業。每個候選都列出哪些面向成立、哪些不成立、哪些地球沒有資料，並對照地球上最接近的地方能到多少。'
    },
  },
  physical: {
    get label() { return getLanguage() === 'en' ? 'Physical match (same-unit properties)' : '物理相符（同單位性質）' },
    get note() {
      return getLanguage() === 'en'
        ? 'Compares orbital chemistry (FeO, TiO₂, K, Th), albedo and roughness with measured Earth values, property by property, and ranks by the match probability of the chosen use. Each candidate shows how close it is and how close Earth can get at all (the Earth ceiling). Earth chemistry exists only where it was measured (North America, Australia, Europe) or within 300 km of measurements.'
        : '直接比對軌道量測的化學成分（FeO、TiO₂、K、Th）、反照率與粗糙度，逐項與地球實測值比較，並依所選用途的相符機率排序；每個候選都附「差多少」與「地球最多能像到多少」（地球上限）。地球化學只在有實測（北美、澳洲、歐洲）或距實測 300 km 內的地方有值。'
    },
  },
  morphology: { label: '地貌研究', note: '比較相同尺度的地形形狀。' },
  material: { label: '地形＋材質', note: '同時比對地形與表面材質（亮度、鐵氧化物、鐵鎂、含水、乾燥度）；地球材質由地質、氣候、土壤與鄰近觀測推估，被植被遮住也能估計。' },
  lavatube: { label: '熔岩管／天窗坑（兩階段）', note: '先篩出玄武岩火山背景再依地形排序，並用自訓練模型偵測天窗坑與崩塌坑。適合選 NASA 介紹過的月球／火星天窗坑。' },
}
