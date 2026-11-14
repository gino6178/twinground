// English display text for server-origin free text (Python literals in web_server.py and src/*.py).
// The API keeps returning the original Chinese values unchanged; the client renders these English
// strings only when English is selected (same mechanism as catalog.js: exact-match lookup).
// Machine-proposed translations reviewed by the i18n_v2 pass; not reviewed by a native-speaking domain expert.
export const SERVER_TEXT = {
  // web_server.py
  "月球選區需同時提供經緯度。": "A Moon selection needs both latitude and longitude.",
  "月球緯度需為 -89.5～89.5 的有限數值；經度需為有限數值。": "Moon latitude must be a finite number from -89.5 to 89.5; longitude must be a finite number.",
  "Kaguya MI 高解析圖層暫時無法讀取": "Kaguya MI high-resolution layers are temporarily unavailable",
  "研究材質格網暫時無法讀取": "The research material grid is temporarily unavailable",
  "NASA POWER 氣候格網暫時無法讀取": "The NASA POWER climate grid is temporarily unavailable",
  "火星選區需同時提供經緯度。": "A Mars selection needs both latitude and longitude.",
  "LROC DTM 覆蓋索引暫時無法讀取": "The LROC DTM coverage index is temporarily unavailable",
  "約 320 m 的 SRTM 重採樣窗格": "SRTM window resampled to about 320 m",
  // lunar_pipeline.py (Moon spectral tendency)
  "光譜覆蓋不足": "Insufficient spectral coverage",
  "偏長石質光譜傾向": "Feldspathic-leaning spectral tendency",
  "偏鎂鐵質光譜傾向": "Mafic-leaning spectral tendency",
  "中間光譜傾向": "Intermediate spectral tendency",
  // moon_crater_inference.py
  "中心坑形模型支援 20 或 40 km 方形窗格": "The central-crater model supports 20 or 40 km square windows only",
  "超過 20 km 模型外部驗證地點的最大絕對緯度 72.75°": "Beyond 72.75°, the highest absolute latitude among the 20 km model's external validation sites",
  "超出 40 km 模型已評估的 ±74° 緯度範圍": "Outside the ±74° latitude range evaluated for the 40 km model",
  "LOLA 高程窗格不可用": "LOLA elevation window unavailable",
  "偏向中心撞擊坑形態": "Leans toward central impact-crater morphology",
  "偏向對照地形": "Leans toward control terrain",
  "平衡抽樣的分類指數，非任意地點有坑機率；不參與地球候選排序": "Classification index from balanced sampling, not the probability of a crater at an arbitrary location; not used to rank Earth candidates",
  "SomBench WAC/DTM 4–<8 km 中心坑；同源 Robbins 標註，非地月類比真值": "SomBench WAC/DTM 4–<8 km central craters; same-source Robbins labels, not ground truth for Earth–Moon analogs",
  // moon_mineral_maps.py / global_mineral_inference.py
  "Kaguya MI 四礦物圖只覆蓋南北緯 50°內": "The Kaguya MI four-mineral maps cover only latitudes within 50°N/S",
  "極區經度窗格超出圖層範圍": "Polar longitude window extends beyond the layer",
  "研究材質模型只覆蓋南北緯 50°內": "The research material model covers only latitudes within 50°N/S",
  "所選位置的獨立輸入圖層缺值": "Independent input layers have missing values at the selected location",
  // highres_lunar_preview.py / lroc_dtm_coverage.py / moon_geology.py
  "已下載的 NAC 立體高程未完整覆蓋這個 3 公里局部窗格": "The downloaded NAC stereo elevation does not fully cover this 3 km local window",
  "LROC NAC DTM 覆蓋索引尚未安裝": "The LROC NAC DTM coverage index is not installed yet",
  "13×13 等距實地窗格抽樣；比例是格點占比，非量測信心或精確面積比例": "13×13 evenly spaced samples across the ground window; proportions are sample-point shares, not measurement confidence or exact area fractions",
  // context_ranker.py
  "沙丘分布來源暫時無法讀取，請稍後重試或改用其他條件。": "The dune distribution source is temporarily unavailable. Retry later or use other criteria.",
  "本尺度的索引沒有符合地表與岩性條件的候選；請放寬類比目標。": "No candidates at this scale meet the surface and lithology criteria. Relax the analog criteria.",
  "不限岩性": "Any lithology",
  "基性深成岩": "Basic plutonic rocks",
  // mars_global.py
  "請選擇緯度 -89.5～89.5、經度 -180～180 的火星區域。": "Select a Mars region with latitude -89.5 to 89.5 and longitude -180 to 180.",
  "火星搜尋尺度必須為 20、40 或 80 km。": "Mars search scale must be 20, 40 or 80 km.",
  "自由選取的火星區域": "Freely selected Mars region",
  "全球粗尺度高程：原始南北格距約 1.85 km；插值不增加實測細節。": "Global coarse-scale elevation: native north–south spacing about 1.85 km; interpolation adds no measured detail.",
  "火星全球高程尚未準備完成，請稍後重試。": "Mars global elevation is not ready yet. Retry later.",
  "此火星方框有缺失高程，請移動選區後重試。": "This Mars box has missing elevation. Move the selection and retry.",
  // microterrain_service.py / build_microterrain_index.py / microterrain_geomorphon.py
  "此位置的原始 DTM 沒有完整高解析方框；請移至有資料的區域或縮小方框": "The native DTM has no complete high-resolution box at this position; move to an area with data or shrink the box",
  "原始 DTM 自由選框": "Native DTM free selection",
  "3DEP 裸地": "3DEP bare earth",
  "Carrizozo 熔岩流候選": "Carrizozo lava-flow candidate",
  "Amboy Crater 已知火星類比場址": "Amboy Crater, known Mars analog site",
  "Big Pine 火山流候選": "Big Pine volcanic-flow candidate",
  "Cima 火山區待驗證候選": "Cima volcanic field, unverified candidate",
  "Death Valley Mars Hill 已知火星類比": "Death Valley Mars Hill, known Mars analog",
  "Idaho Craters of the Moon 已知月／火火山類比": "Idaho Craters of the Moon, known Moon/Mars volcanic analog",
  "Olympus Mons 熔岩流觀測區": "Olympus Mons lava-flow study area",
  "Nassau 附近": "Near Nassau",
  "Thiel 附近": "Near Thiel",
  "Potrillo 火山區": "Potrillo volcanic field",
  "無": "None",
  "平地": "Flat",
  "峰": "Peak",
  "稜": "Ridge",
  "上坡肩": "Shoulder",
  "側脊": "Spur",
  "坡": "Slope",
  "凹坡": "Hollow",
  "下坡腳": "Footslope",
  "谷": "Valley",
  "坑": "Pit",
}

// Server f-strings: values are copied verbatim from the original text.
export const SERVER_PATTERNS = [
  [/^四圖共同有效格點僅 ([\d.]+%)$/, v => 'Only ' + v + ' of grid points are valid in all four maps'],
  [/^東 ([-+]?[\d.]+) km／北 ([-+]?[\d.]+) km$/, (e, n) => 'East ' + e + ' km / North ' + n + ' km'],
]
