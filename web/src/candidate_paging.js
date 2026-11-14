const signature = d => JSON.stringify([d.window.body,d.window.lat,d.window.lon,d.window.patch_km,d.purpose||'morphology',d.model_sha256,d.index_provenance?.sha256,d.context_ranking?.version,d.context_ranking?.target,d.context_ranking?.dune_presence_source?.source_sha256])
export function nextCandidateOffset(data) {
 if(data.saved_snapshot)return null
 const g=data.candidate_groups
 if(!g)return null
 if(g.next_offset!==undefined)return g.next_offset
 return data.matches.length<g.group_count?data.matches.length:null
}
export function mergeCandidatePage(previous,page) {
 const g=page.candidate_groups
 const offset=g?.offset||0,limit=g?.limit||5
 if(offset===0)return {...page,loaded_pages:[{offset,limit}]}
 if(!previous||previous.saved_snapshot||signature(previous)!==signature(page)||nextCandidateOffset(previous)!==offset)throw Error('搜尋版本或分頁已改變，請重新搜尋。')
 const ids=new Set(previous.matches.map(m=>m.id))
 if(page.matches.some(m=>ids.has(m.id)))throw Error('候選分頁重複，請重新搜尋。')
 return {...page,matches:[...previous.matches,...page.matches],loaded_pages:[...(previous.loaded_pages||[{offset:0,limit:previous.matches.length}]),{offset,limit}],candidate_groups:{...g,returned_groups:previous.matches.length+page.matches.length}}
}
